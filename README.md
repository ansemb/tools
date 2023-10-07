# tools

## gifskeeno

CLI (cross-platform) for converting video to gif using `ffmpeg` and `gifski` - these needs to be installed.

### installation

- [ffmpeg](https://ffmpeg.org/download.html)

```bash
# ubuntu
sudo apt install ffmpeg

# windows
winget install --id=Gyan.FFmpeg  -e

# macos
brew install ffmpeg

```

- [gifski](https://gif.ski/)

```bash
cargo install gifski
```

```bash
deno install -f --allow-run --allow-write https://raw.githubusercontent.com/ansemb/tools/main/gifskeeno/gifskeeno.ts
```

### usage

Downscales the video by default.

```bash
gifskeeno ./screencast-01.webm

# outputs:
# ./screencast-01.gif
```

```bash
gifskeeno --help
```
