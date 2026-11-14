# Whisper Drop

Drag-and-drop local transcription for audio and video files. An Electron front end for
[whisper.cpp](https://github.com/ggml-org/whisper.cpp)'s `whisper-server`; everything runs on your machine.

## Features

- Drop files (or click to pick) to queue transcription jobs
- Per-job progress bar
- Autosave as `.txt`, `.srt` or `.vtt`, optionally into a chosen output folder (never overwrites existing files)
- Bundled ffmpeg converts any audio/video input
- Works with whisper.cpp, or any server exposing `/v1/audio/transcriptions`

## Requirements

- Windows x64, Node.js 20+
- NVIDIA GPU recommended (6 GB VRAM is plenty for the default model)

## Setup

```bash
npm install
npm run setup
npm start
```

`npm run setup` downloads the whisper.cpp CUDA build into `bin/` and the
`ggml-large-v3-turbo-q5_0` model (~550 MB) into `models/`. Both are git-ignored.

If Electron's binary is missing after `npm install` (npm may block install scripts), run:

```bash
node node_modules/electron/install.js
```

## Using another server

Set **Backend** to *OpenAI-compatible* and the base URL to your server. The app calls
`POST {baseUrl}/v1/audio/transcriptions` with `response_format=verbose_json`.

## Notes

- Progress percentages are only available when the app starts `whisper-server` itself.
- Settings are stored in the per-user app data folder, not in this repository.
