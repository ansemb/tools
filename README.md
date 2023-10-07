# tools

## gifskeeno

CLI for converting video to gif using `ffmpeg` and `gifski`.

### installation

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
