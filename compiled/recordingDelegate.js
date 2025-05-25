import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { env } from 'node:process';
import { APIEvent, AudioRecordingCodecType, H264Level, H264Profile } from 'homebridge';
import { PreBuffer } from './prebuffer.js';
import { PREBUFFER_LENGTH, ffmpegPathString } from './settings.js';
export async function listenServer(server, log) {
    let isListening = false;
    while (!isListening) {
        const port = 10000 + Math.round(Math.random() * 30000);
        server.listen(port);
        try {
            await once(server, 'listening');
            isListening = true;
            const address = server.address();
            if (address && typeof address === 'object' && 'port' in address) {
                return address.port;
            }
            throw new Error('Failed to get server address');
        }
        catch (e) {
            log.error('Error while listening to the server:', e);
        }
    }
    // Add a return statement to ensure the function always returns a number
    return 0;
}
export async function readLength(readable, length) {
    if (!length) {
        return Buffer.alloc(0);
    }
    {
        const ret = readable.read(length);
        if (ret) {
            return ret;
        }
    }
    return new Promise((resolve, reject) => {
        const r = () => {
            const ret = readable.read(length);
            if (ret) {
                // eslint-disable-next-line ts/no-use-before-define
                cleanup();
                resolve(ret);
            }
        };
        const e = () => {
            // eslint-disable-next-line ts/no-use-before-define
            cleanup();
            reject(new Error(`stream ended during read for minimum ${length} bytes`));
        };
        const cleanup = () => {
            readable.removeListener('readable', r);
            readable.removeListener('end', e);
        };
        readable.on('readable', r);
        readable.on('end', e);
    });
}
export async function* parseFragmentedMP4(readable) {
    while (true) {
        const header = await readLength(readable, 8);
        const length = header.readInt32BE(0) - 8;
        const type = header.slice(4).toString();
        const data = await readLength(readable, length);
        yield {
            header,
            length,
            type,
            data,
        };
    }
}
export class RecordingDelegate {
    updateRecordingActive(active) {
        this.log.info(`Recording active status changed to: ${active}`, this.cameraName);
        return Promise.resolve();
    }
    updateRecordingConfiguration(configuration) {
        this.log.info('Recording configuration updated', this.cameraName);
        this.currentRecordingConfiguration = configuration;
        return Promise.resolve();
    }
    async *handleRecordingStreamRequest(streamId) {
        this.log.info(`Recording stream request received for stream ID: ${streamId}`, this.cameraName);
        if (!this.currentRecordingConfiguration) {
            this.log.error('No recording configuration available', this.cameraName);
            return;
        }
        try {
            // Use existing handleFragmentsRequests method but track the process
            const fragmentGenerator = this.handleFragmentsRequests(this.currentRecordingConfiguration, streamId);
            for await (const fragmentBuffer of fragmentGenerator) {
                yield {
                    data: fragmentBuffer,
                    isLast: false // TODO: implement proper last fragment detection
                };
            }
        }
        catch (error) {
            this.log.error(`Recording stream error: ${error}`, this.cameraName);
        }
        finally {
            // Cleanup will be handled by closeRecordingStream
            this.log.debug(`Recording stream ${streamId} generator finished`, this.cameraName);
        }
    }
    closeRecordingStream(streamId, reason) {
        this.log.info(`Recording stream closed for stream ID: ${streamId}, reason: ${reason}`, this.cameraName);
        // Kill any active FFmpeg processes for this stream
        const process = this.activeFFmpegProcesses.get(streamId);
        if (process && !process.killed) {
            this.log.debug(`Terminating FFmpeg process for stream ${streamId}`, this.cameraName);
            process.kill('SIGTERM');
            this.activeFFmpegProcesses.delete(streamId);
        }
    }
    hap;
    log;
    cameraName;
    videoConfig;
    process;
    videoProcessor;
    controller;
    preBufferSession;
    preBuffer;
    // Add fields for recording configuration and process management
    currentRecordingConfiguration;
    activeFFmpegProcesses = new Map();
    constructor(log, cameraName, videoConfig, api, hap, videoProcessor) {
        this.log = log;
        this.hap = hap;
        this.cameraName = cameraName;
        this.videoProcessor = videoProcessor || ffmpegPathString || 'ffmpeg';
        api.on(APIEvent.SHUTDOWN, () => {
            if (this.preBufferSession) {
                this.preBufferSession.process?.kill();
                this.preBufferSession.server?.close();
            }
        });
    }
    async startPreBuffer() {
        this.log.info(`start prebuffer ${this.cameraName}, prebuffer: ${this.videoConfig?.prebuffer}`);
        if (this.videoConfig?.prebuffer) {
            // looks like the setupAcessory() is called multiple times during startup. Ensure that Prebuffer runs only once
            if (!this.preBuffer) {
                this.preBuffer = new PreBuffer(this.log, this.videoConfig.source ?? '', this.cameraName, this.videoProcessor);
                if (!this.preBufferSession) {
                    this.preBufferSession = await this.preBuffer.startPreBuffer();
                }
            }
        }
    }
    async *handleFragmentsRequests(configuration, streamId) {
        this.log.debug('video fragments requested', this.cameraName);
        const iframeIntervalSeconds = 4;
        const audioArgs = [
            '-acodec',
            'libfdk_aac',
            ...(configuration.audioCodec.type === AudioRecordingCodecType.AAC_LC
                ? ['-profile:a', 'aac_low']
                : ['-profile:a', 'aac_eld']),
            '-ar',
            `${configuration.audioCodec.samplerate}k`,
            '-b:a',
            `${configuration.audioCodec.bitrate}k`,
            '-ac',
            `${configuration.audioCodec.audioChannels}`,
        ];
        const profile = configuration.videoCodec.parameters.profile === H264Profile.HIGH
            ? 'high'
            : configuration.videoCodec.parameters.profile === H264Profile.MAIN ? 'main' : 'baseline';
        const level = configuration.videoCodec.parameters.level === H264Level.LEVEL4_0
            ? '4.0'
            : configuration.videoCodec.parameters.level === H264Level.LEVEL3_2 ? '3.2' : '3.1';
        const videoArgs = [
            '-an',
            '-sn',
            '-dn',
            '-codec:v',
            'libx264',
            '-pix_fmt',
            'yuv420p',
            '-profile:v',
            profile,
            '-level:v',
            level,
            '-b:v',
            `${configuration.videoCodec.parameters.bitRate}k`,
            '-force_key_frames',
            `expr:eq(t,n_forced*${iframeIntervalSeconds})`,
            '-r',
            configuration.videoCodec.resolution[2].toString(),
        ];
        const ffmpegInput = [];
        if (this.videoConfig?.prebuffer) {
            const input = this.preBuffer ? await this.preBuffer.getVideo(configuration.mediaContainerConfiguration.fragmentLength ?? PREBUFFER_LENGTH) : [];
            ffmpegInput.push(...input);
        }
        else {
            ffmpegInput.push(...(this.videoConfig?.source ?? '').split(' '));
        }
        this.log.debug('Start recording...', this.cameraName);
        const session = await this.startFFMPegFragmetedMP4Session(this.videoProcessor, ffmpegInput, audioArgs, videoArgs);
        this.log.info('Recording started', this.cameraName);
        const { socket, cp, generator } = session;
        // Track the FFmpeg process for this stream
        this.activeFFmpegProcesses.set(streamId, cp);
        let pending = [];
        let filebuffer = Buffer.alloc(0);
        try {
            for await (const box of generator) {
                const { header, type, length, data } = box;
                pending.push(header, data);
                if (type === 'moov' || type === 'mdat') {
                    const fragment = Buffer.concat(pending);
                    filebuffer = Buffer.concat([filebuffer, Buffer.concat(pending)]);
                    pending = [];
                    yield fragment;
                }
                this.log.debug(`mp4 box type ${type} and lenght: ${length}`, this.cameraName);
            }
        }
        catch (e) {
            this.log.info(`Recoding completed. ${e}`, this.cameraName);
            /*
                  const homedir = require('os').homedir();
                  const path = require('path');
                  const writeStream = fs.createWriteStream(homedir+path.sep+Date.now()+'_video.mp4');
                  writeStream.write(filebuffer);
                  writeStream.end();
                  */
        }
        finally {
            socket.destroy();
            cp.kill();
            // Remove from active processes tracking
            this.activeFFmpegProcesses.delete(streamId);
            // this.server.close;
        }
    }
    async startFFMPegFragmetedMP4Session(ffmpegPath, ffmpegInput, audioOutputArgs, videoOutputArgs) {
        return new Promise((resolve) => {
            const server = createServer((socket) => {
                server.close();
                async function* generator() {
                    while (true) {
                        const header = await readLength(socket, 8);
                        const length = header.readInt32BE(0) - 8;
                        const type = header.slice(4).toString();
                        const data = await readLength(socket, length);
                        yield {
                            header,
                            length,
                            type,
                            data,
                        };
                    }
                }
                const cp = this.process;
                resolve({
                    socket,
                    cp,
                    generator: generator(),
                });
            });
            listenServer(server, this.log).then((serverPort) => {
                const args = [];
                args.push(...ffmpegInput);
                // args.push(...audioOutputArgs);
                args.push('-f', 'mp4');
                args.push(...videoOutputArgs);
                args.push('-fflags', '+genpts', '-reset_timestamps', '1');
                args.push('-movflags', 'frag_keyframe+empty_moov+default_base_moof', `tcp://127.0.0.1:${serverPort}`);
                this.log.debug(`${ffmpegPath} ${args.join(' ')}`, this.cameraName);
                const debug = false;
                const stdioValue = debug ? 'pipe' : 'ignore';
                this.process = spawn(ffmpegPath, args, { env, stdio: stdioValue });
                const cp = this.process;
                if (debug) {
                    if (cp.stdout) {
                        cp.stdout.on('data', (data) => this.log.debug(data.toString(), this.cameraName));
                    }
                    if (cp.stderr) {
                        cp.stderr.on('data', (data) => this.log.debug(data.toString(), this.cameraName));
                    }
                }
            });
        });
    }
}
