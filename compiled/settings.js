import { defaultFfmpegPath } from '@homebridge/camera-utils';
import { readFileSync } from 'fs';
export const PLUGIN_NAME = '@homebridge-plugins/homebridge-camera-ffmpeg';
export const PLATFORM_NAME = 'Camera-ffmpeg';
export const ffmpegPathString = defaultFfmpegPath;
export const defaultPrebufferDuration = 15000;
export const PREBUFFER_LENGTH = 4000;
export const FRAGMENTS_LENGTH = 4000;
export function getVersion() {
    const json = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
    const version = json.version;
    return version;
}
