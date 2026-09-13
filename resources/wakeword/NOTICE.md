# Wake-word models — third-party notice

`melspectrogram.onnx`, `embedding_model.onnx`, and `hey_jarvis_v0.1.onnx` are
redistributed unmodified from the [openWakeWord](https://github.com/dscripka/openWakeWord)
project (release v0.5.1), © David Scripka, licensed under the
[Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0). No changes
have been made to these files.

They implement the three-stage pipeline `presence/wakeword.ts` runs to detect
the "hey jarvis" keyword entirely on-device: raw audio → mel-spectrogram →
speech embedding → keyword classifier. See openWakeWord's own
`docs/models/hey_jarvis.md` for training details and accuracy notes.
