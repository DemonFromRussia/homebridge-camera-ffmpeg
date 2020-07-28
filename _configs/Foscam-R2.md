---
layout: config
title: Foscam R2
---
Working through RTSP

```json
{
  "platform": "Camera-ffmpeg",
  "cameras": [
    {
      "name": "Camera",
      "videoConfig": {
      	"source": "-re -i rtsp://user:pass@10.0.1.132:47082/videoMain",
        "stillImageSource": "-i http://10.0.1.132:47082/cgi-bin/CGIProxy.fcgi?cmd=snapPicture2&usr=user&pwd=pass&",
      	"maxStreams": 2,
      	"maxWidth": 1280,
      	"maxHeight": 720,
      	"maxFPS": 30
      }
    }
  ]
}
```