# Whisper Drop

Drag-and-drop local transcription for audio and video files. An Electron front end for
[whisper.cpp](https://github.com/ggml-org/whisper.cpp)'s `whisper-server`; everything runs on your machine.

## Features

- Drop files (or click to pick) to queue transcription jobs
- Per-job progress bar, plus queue controls:
  - **Pause / Resume** holds the queue after the current file finishes
  - **Stop** cancels the current file and everything still queued
  - **Reset** stops and clears the whole list
- Drop whole folders: media files are found recursively and queued in natural order (`Lesson 2` before `Lesson 10`)
- Autosave as `.txt`, `.srt` or `.vtt`, next to each source file or into a chosen output folder
  - With an output folder, a dropped folder's structure is mirrored (`Course/Lesson 1/intro.mp3` → `<out>/Course/Lesson 1/intro.srt`)
  - Existing transcripts are never overwritten (`name (1).srt`), or tick **Skip existing** to resume an interrupted batch
  - `intro.mp3` and `intro.mp4` in the same folder are saved as `intro.mp3.srt` / `intro.mp4.srt`
- Optional **screenshots** for video files (needs Autosave): stills are saved to `<name>_shots/` and a
  Markdown transcript `<name>.md` interleaves them with the speech (the `.srt`/`.vtt`/`.txt` is still written too)
  - **Slides**: capture on big visual changes. **Screen recording**: also on small changes (typing, new windows,
    plus a safety-net capture every 60 s). **Every N seconds**: fixed interval.
  - A still is taken once the picture has held still for about a second, so mid-transition frames are skipped;
    captures are at least 2 s apart. Images are JPEGs, at most 1600 px wide.
  - Each image is placed just before the passage being spoken when it was captured
  - Audio-only files are unaffected. Analysis runs on the CPU while the GPU transcribes
  - The sensitivity presets are untuned starting points (see `PRESETS` in `src/screenshots.js`); constantly
    moving video (e.g. a webcam feed) will trigger a capture roughly every 10 s
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

## License

[MIT](LICENSE). whisper.cpp, ffmpeg and the Whisper model weights are separate projects with their own licenses.
