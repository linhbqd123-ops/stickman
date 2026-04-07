# Saitama Video Upload (Ultimate V2)

Place your cinematic file at:

`assets/videos/saitama_punch.mp4`

The Saitama ultimate will play this full-screen video before applying global damage.

Recommended settings:

1. Duration: 3-5 seconds
2. Resolution: 1280x720 or 1920x1080
3. Codec: H.264
4. Format: MP4
5. Suggested max size: under 20 MB

If playback fails (unsupported codec or missing file), the game will skip video playback and still execute the Saitama damage phase.

Example ffmpeg command:

```bash
ffmpeg -i input.mp4 -c:v libx264 -crf 23 -preset medium -movflags +faststart -an assets/videos/saitama_punch.mp4
```
