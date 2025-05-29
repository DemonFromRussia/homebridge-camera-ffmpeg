import type { ChildProcess } from 'node:child_process'
import type { Server } from 'node:net'
import type { Readable } from 'node:stream'

import type { API, CameraController, CameraRecordingConfiguration, CameraRecordingDelegate, HAP, HDSProtocolSpecificErrorReason, RecordingPacket } from 'homebridge'

import type { VideoConfig } from './settings.js'
import type { Logger } from './logger.js'
import type { Mp4Session } from './settings.js'

import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { env } from 'node:process'

import { APIEvent, AudioRecordingCodecType, H264Level, H264Profile } from 'homebridge'

import { PreBuffer } from './prebuffer.js'

import { MP4Atom, FFMpegFragmentedMP4Session, PREBUFFER_LENGTH, ffmpegPathString } from './settings.js'

export async function listenServer(server: Server, log: Logger): Promise<number> {
  let isListening = false
  while (!isListening) {
    const port = 10000 + Math.round(Math.random() * 30000)
    server.listen(port)
    try {
      await once(server, 'listening')
      isListening = true
      const address = server.address()
      if (address && typeof address === 'object' && 'port' in address) {
        return address.port
      }
      throw new Error('Failed to get server address')
    } catch (e: any) {
      log.error('Error while listening to the server:', e)
    }
  }
  // Add a return statement to ensure the function always returns a number
  return 0
}

export async function readLength(readable: Readable, length: number): Promise<Buffer> {
  if (!length) {
    return Buffer.alloc(0)
  }

  {
    const ret = readable.read(length)
    if (ret) {
      return ret
    }
  }

  return new Promise((resolve, reject) => {
    const r = (): void => {
      const ret = readable.read(length)
      if (ret) {
        // eslint-disable-next-line ts/no-use-before-define
        cleanup()
        resolve(ret)
      }
    }

    const e = (): void => {
      // eslint-disable-next-line ts/no-use-before-define
      cleanup()
      reject(new Error(`stream ended during read for minimum ${length} bytes`))
    }

    const cleanup = (): void => {
      readable.removeListener('readable', r)
      readable.removeListener('end', e)
    }

    readable.on('readable', r)
    readable.on('end', e)
  })
}

export async function* parseFragmentedMP4(readable: Readable): AsyncGenerator<MP4Atom> {
  while (true) {
    const header = await readLength(readable, 8)
    const length = header.readInt32BE(0) - 8
    const type = header.slice(4).toString()
    const data = await readLength(readable, length)

    yield {
      header,
      length,
      type,
      data,
    }
  }
}

export class RecordingDelegate implements CameraRecordingDelegate {
  updateRecordingActive(active: boolean): Promise<void> {
    this.log.info(`Recording active status changed to: ${active}`, this.cameraName)
    return Promise.resolve()
  }

  updateRecordingConfiguration(configuration: CameraRecordingConfiguration | undefined): Promise<void> {
    this.log.info('Recording configuration updated', this.cameraName)
    this.currentRecordingConfiguration = configuration
    return Promise.resolve()
  }

  async *handleRecordingStreamRequest(streamId: number): AsyncGenerator<RecordingPacket, any, any> {
    this.log.info(`Recording stream request received for stream ID: ${streamId}`, this.cameraName)
    
    if (!this.currentRecordingConfiguration) {
      this.log.error('No recording configuration available', this.cameraName)
      return
    }

    // Create abort controller for this stream
    const abortController = new AbortController()
    this.streamAbortControllers.set(streamId, abortController)

    try {
      // Use existing handleFragmentsRequests method but track the process
      const fragmentGenerator = this.handleFragmentsRequests(this.currentRecordingConfiguration, streamId)
      
      let fragmentCount = 0
      let totalBytes = 0
      
      for await (const fragmentBuffer of fragmentGenerator) {
        // Check if stream was aborted
        if (abortController.signal.aborted) {
          this.log.debug(`Recording stream ${streamId} aborted, stopping generator`, this.cameraName)
          break
        }
        
        fragmentCount++
        totalBytes += fragmentBuffer.length
        
        // Enhanced logging for HKSV debugging
        this.log.debug(`HKSV: Yielding fragment #${fragmentCount}, size: ${fragmentBuffer.length}, total: ${totalBytes} bytes`, this.cameraName)
        
        yield {
          data: fragmentBuffer,
          isLast: false // We'll handle the last fragment properly when the stream ends
        }
      }
      
      // Send final packet to indicate end of stream
      this.log.info(`HKSV: Recording stream ${streamId} completed. Total fragments: ${fragmentCount}, total bytes: ${totalBytes}`, this.cameraName)
      
    } catch (error) {
      this.log.error(`Recording stream error: ${error}`, this.cameraName)
      // Send error indication
      yield {
        data: Buffer.alloc(0),
        isLast: true
      }
    } finally {
      // Cleanup
      this.streamAbortControllers.delete(streamId)
      this.log.debug(`Recording stream ${streamId} generator finished`, this.cameraName)
    }
  }

  closeRecordingStream(streamId: number, reason: HDSProtocolSpecificErrorReason | undefined): void {
    this.log.info(`Recording stream closed for stream ID: ${streamId}, reason: ${reason}`, this.cameraName)
    
    // Abort the stream generator
    const abortController = this.streamAbortControllers.get(streamId)
    if (abortController) {
      abortController.abort()
      this.streamAbortControllers.delete(streamId)
    }
    
    // Kill any active FFmpeg processes for this stream
    const process = this.activeFFmpegProcesses.get(streamId)
    if (process && !process.killed) {
      this.log.debug(`Terminating FFmpeg process for stream ${streamId}`, this.cameraName)
      process.kill('SIGTERM')
      this.activeFFmpegProcesses.delete(streamId)
    }
  }

  private readonly hap: HAP
  private readonly log: Logger
  private readonly cameraName: string
  private readonly videoConfig: VideoConfig
  private process!: ChildProcess

  private readonly videoProcessor: string
  readonly controller?: CameraController
  private preBufferSession?: Mp4Session
  private preBuffer?: PreBuffer
  
  // Add fields for recording configuration and process management
  private currentRecordingConfiguration?: CameraRecordingConfiguration
  private activeFFmpegProcesses = new Map<number, ChildProcess>()
  private streamAbortControllers = new Map<number, AbortController>()

  constructor(log: Logger, cameraName: string, videoConfig: VideoConfig, api: API, hap: HAP, videoProcessor?: string) {
    this.log = log
    this.hap = hap
    this.cameraName = cameraName
    this.videoConfig = videoConfig
    this.videoProcessor = videoProcessor || ffmpegPathString || 'ffmpeg'

    api.on(APIEvent.SHUTDOWN, () => {
      if (this.preBufferSession) {
        this.preBufferSession.process?.kill()
        this.preBufferSession.server?.close()
      }
      
      // Cleanup active streams on shutdown
      this.activeFFmpegProcesses.forEach((process, streamId) => {
        if (!process.killed) {
          this.log.debug(`Shutdown: Terminating FFmpeg process for stream ${streamId}`, this.cameraName)
          process.kill('SIGTERM')
        }
      })
      this.activeFFmpegProcesses.clear()
      this.streamAbortControllers.clear()
    })
  }

  async startPreBuffer(): Promise<void> {
    this.log.info(`start prebuffer ${this.cameraName}, prebuffer: ${this.videoConfig?.prebuffer}`)
    if (this.videoConfig?.prebuffer) {
      // looks like the setupAcessory() is called multiple times during startup. Ensure that Prebuffer runs only once
      if (!this.preBuffer) {
        this.preBuffer = new PreBuffer(this.log, this.videoConfig.source ?? '', this.cameraName, this.videoProcessor)
        if (!this.preBufferSession) {
          this.preBufferSession = await this.preBuffer.startPreBuffer()
        }
      }
    }
  }

  async * handleFragmentsRequests(configuration: CameraRecordingConfiguration, streamId: number): AsyncGenerator<Buffer, void, unknown> {
    this.log.info(`🔍 HKSV DEBUG: Starting handleFragmentsRequests for stream ${streamId}`, this.cameraName)
    this.log.debug('video fragments requested', this.cameraName)
    this.log.debug(`DEBUG: handleFragmentsRequests called for stream ${streamId}`, this.cameraName)

    // EXTENSIVE DEBUGGING for HKSV troubleshooting
    this.log.info(`🔧 HKSV DEBUG: videoConfig exists: ${!!this.videoConfig}`, this.cameraName)
    this.log.info(`🔧 HKSV DEBUG: videoConfig.source: "${this.videoConfig?.source || 'UNDEFINED'}"`, this.cameraName)
    this.log.info(`🔧 HKSV DEBUG: videoConfig.audio: ${this.videoConfig?.audio}`, this.cameraName)
    this.log.info(`🔧 HKSV DEBUG: videoConfig.prebuffer: ${this.videoConfig?.prebuffer}`, this.cameraName)
    this.log.info(`🔧 HKSV DEBUG: configuration exists: ${!!configuration}`, this.cameraName)

    const iframeIntervalSeconds = 4

    const audioArgs: Array<string> = [
      '-acodec',
      'aac', // Use standard aac encoder for better compatibility
      '-profile:a',
      'aac_low',
      '-ar',
      '32k', // Use proven audio settings for HomeKit
      '-b:a',
      '64k',
      '-ac',
      '1',
    ]

    // Universal encoding for HKSV compatibility - works with any input source  
    const videoArgs: Array<string> = [
      // Only disable audio if explicitly disabled in config
      ...(this.videoConfig?.audio === false ? ['-an'] : []),
      '-sn',
      '-dn',
      '-vcodec',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-profile:v',
      'baseline', // Force baseline for maximum HKSV compatibility
      '-level:v',
      '3.1',      // Force level 3.1 for HKSV compatibility
      '-preset',
      'ultrafast',
      '-tune',
      'zerolatency',
      '-g',
      '60',
      '-keyint_min',
      '60',
      '-sc_threshold',
      '0',
      '-force_key_frames',
      'expr:gte(t,n_forced*4)',
      '-b:v',
      '800k',
      '-maxrate',
      '1000k',
      '-bufsize',
      '1000k',
    ]

    const ffmpegInput: Array<string> = []

    if (this.videoConfig?.prebuffer) {
      this.log.info(`🔧 HKSV DEBUG: Using prebuffer mode`, this.cameraName)
      const input: Array<string> = this.preBuffer ? await this.preBuffer.getVideo(configuration.mediaContainerConfiguration.fragmentLength ?? PREBUFFER_LENGTH) : []
      this.log.info(`🔧 HKSV DEBUG: Prebuffer input: ${JSON.stringify(input)}`, this.cameraName)
      ffmpegInput.push(...input)
    } else {
      this.log.info(`🔧 HKSV DEBUG: Using direct source mode`, this.cameraName)
      const sourceArgs = (this.videoConfig?.source ?? '').split(' ')
      this.log.info(`🔧 HKSV DEBUG: Source args: ${JSON.stringify(sourceArgs)}`, this.cameraName)
      ffmpegInput.push(...sourceArgs)
    }
    
    this.log.info(`🔧 HKSV DEBUG: Final ffmpegInput: ${JSON.stringify(ffmpegInput)}`, this.cameraName)
    this.log.info(`🔧 HKSV DEBUG: ffmpegInput length: ${ffmpegInput.length}`, this.cameraName)
    
    if (ffmpegInput.length === 0) {
      this.log.error(`🚨 HKSV ERROR: ffmpegInput is empty! This will cause FFmpeg to fail with code 234`, this.cameraName)
      throw new Error('No video source configured for recording')
    }

    this.log.debug('Start recording...', this.cameraName)

    const session = await this.startFFMPegFragmetedMP4Session(this.videoProcessor, ffmpegInput, audioArgs, videoArgs)
    this.log.info('Recording started', this.cameraName)

    const { socket, cp, generator } = session
    
    // Track the FFmpeg process for this stream
    this.activeFFmpegProcesses.set(streamId, cp)

    let pending: Array<Buffer> = []
    let filebuffer: Buffer = Buffer.alloc(0)
    let isFirstFragment = true
    
    try {
      for await (const box of generator) {
        const { header, type, length, data } = box

        pending.push(header, data)

        // HKSV requires specific MP4 structure:
        // 1. First packet: ftyp + moov (initialization data)
        // 2. Subsequent packets: moof + mdat (media fragments)
        if (isFirstFragment) {
          // For initialization segment, wait for both ftyp and moov
          if (type === 'moov') {
            const fragment = Buffer.concat(pending)
            filebuffer = Buffer.concat([filebuffer, fragment])
            pending = []
            isFirstFragment = false
            this.log.debug(`HKSV: Sending initialization segment (ftyp+moov), size: ${fragment.length}`, this.cameraName)
            yield fragment
          }
        } else {
          // For media segments, send moof+mdat pairs
          if (type === 'mdat') {
            const fragment = Buffer.concat(pending)
            filebuffer = Buffer.concat([filebuffer, fragment])
            pending = []
            this.log.debug(`HKSV: Sending media fragment (moof+mdat), size: ${fragment.length}`, this.cameraName)
            yield fragment
          }
        }
        
        this.log.debug(`mp4 box type ${type} and length: ${length}`, this.cameraName)
      }
    } catch (e) {
      this.log.info(`Recording completed. ${e}`, this.cameraName)
      /*
            const homedir = require('os').homedir();
            const path = require('path');
            const writeStream = fs.createWriteStream(homedir+path.sep+Date.now()+'_video.mp4');
            writeStream.write(filebuffer);
            writeStream.end();
            */
    } finally {
      socket.destroy()
      cp.kill()
      // Remove from active processes tracking
      this.activeFFmpegProcesses.delete(streamId)
      // this.server.close;
    }
  }

  async startFFMPegFragmetedMP4Session(ffmpegPath: string, ffmpegInput: Array<string>, audioOutputArgs: Array<string>, videoOutputArgs: Array<string>): Promise<FFMpegFragmentedMP4Session> {
    return new Promise((resolve) => {
      const server = createServer((socket) => {
        server.close()
        async function* generator(): AsyncGenerator<MP4Atom> {
          while (true) {
            const header = await readLength(socket, 8)
            const length = header.readInt32BE(0) - 8
            const type = header.slice(4).toString()
            const data = await readLength(socket, length)

            yield {
              header,
              length,
              type,
              data,
            }
          }
        }
        const cp = this.process
        resolve({
          socket,
          cp,
          generator: generator(),
        })
      })

      listenServer(server, this.log).then((serverPort) => {
        const args: Array<string> = []

        args.push(...ffmpegInput)

        // Include audio only if enabled in config
        if (this.videoConfig?.audio !== false) {
          args.push(...audioOutputArgs)
        }

        args.push('-f', 'mp4')
        args.push(...videoOutputArgs)
        
        // Optimized fragmentation settings that work with HKSV
        args.push('-movflags', 'frag_keyframe+empty_moov+default_base_moof+skip_sidx+skip_trailer')
        args.push(
          '-fflags',
          '+genpts+igndts+ignidx'
        )
        args.push('-reset_timestamps', '1')
        args.push('-max_delay', '5000000')
        
        args.push(
          '-err_detect',
          'ignore_err'
        )

        args.push(
          `tcp://127.0.0.1:${serverPort}`
        )

        this.log.debug(`${ffmpegPath} ${args.join(' ')}`, this.cameraName)

        // Enhanced debugging and logging for HomeKit Secure Video recording
        this.log.debug(`DEBUG: startFFMPegFragmetedMP4Session called`, this.cameraName)
        this.log.debug(`DEBUG: Video source: "${ffmpegInput.join(' ')}"`, this.cameraName)
        this.log.debug(`DEBUG: FFmpeg input args: ${JSON.stringify(ffmpegInput)}`, this.cameraName)
        this.log.debug(`DEBUG: Audio enabled: ${!!this.currentRecordingConfiguration?.audioCodec}`, this.cameraName)
        this.log.debug(`DEBUG: Creating server`, this.cameraName)
        this.log.debug(`DEBUG: Server listening on port ${serverPort}`, this.cameraName)
        this.log.debug(`DEBUG: Complete FFmpeg command: ${ffmpegPath} ${args.join(' ')}`, this.cameraName)
        this.log.debug(`DEBUG: Starting FFmpeg`, this.cameraName)

        const debug = true // Enable debug for HKSV troubleshooting

        const stdioValue = debug ? 'pipe' : 'ignore'
        this.process = spawn(ffmpegPath, args, { env, stdio: stdioValue })
        const cp = this.process

        this.log.debug(`DEBUG: FFmpeg started with PID ${cp.pid}`, this.cameraName)

        if (debug) {
          let frameCount = 0
          let lastLogTime = Date.now()
          const logInterval = 5000 // Log every 5 seconds
          
          if (cp.stdout) {
            cp.stdout.on('data', (data: Buffer) => {
              const output = data.toString()
              this.log.debug(`FFmpeg stdout: ${output}`, this.cameraName)
            })
          }
          if (cp.stderr) {
            cp.stderr.on('data', (data: Buffer) => {
              const output = data.toString()
              
              // Count frames for progress tracking
              const frameMatch = output.match(/frame=\s*(\d+)/)
              if (frameMatch) {
                frameCount = parseInt(frameMatch[1])
                const now = Date.now()
                if (now - lastLogTime >= logInterval) {
                  this.log.info(`Recording progress: ${frameCount} frames processed`, this.cameraName)
                  lastLogTime = now
                }
              }
              
              // Check for HKSV specific errors
              if (output.includes('invalid NAL unit size') || output.includes('decode_slice_header error')) {
                this.log.warn(`HKSV: Potential stream compatibility issue detected: ${output.trim()}`, this.cameraName)
              }
              
              this.log.debug(`FFmpeg stderr: ${output}`, this.cameraName)
            })
          }
        }
        
        // Enhanced process cleanup and error handling
        cp.on('exit', (code, signal) => {
          this.log.debug(`DEBUG: FFmpeg process ${cp.pid} exited with code ${code}, signal ${signal}`, this.cameraName)
          if (code !== 0 && code !== null) {
            this.log.warn(`HKSV: FFmpeg exited with non-zero code ${code}, this may indicate stream issues`, this.cameraName)
          }
        })
        
        cp.on('error', (error) => {
          this.log.error(`DEBUG: FFmpeg process error: ${error}`, this.cameraName)
        })
      })
    })
  }
}
