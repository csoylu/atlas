Here's where #42 stands. The models are benchmarked and I'm now building the comparison page and doc.

**Speech-to-text so far.** I tested on your 37 "Hey Atlas" recordings from #39, 12 real English and 12 real Turkish clips from Google's FLEURS read-speech set, and my TTS clips played back through each model. All runs used CPU with 4 threads.

| Model | English error rate (FLEURS) | Turkish error rate (FLEURS) | "Atlas" heard in your clips | Time to text, your ~4 s clips |
|---|---|---|---|---|
| Parakeet v3 (current, no Turkish) | 6.1% | — | 8/29 | 90 ms |
| Whisper large-v3-turbo | 4.2% | **8.1%** | 15/29 (17/29 with the language set to English) | ~700–800 ms |
| Whisper small | 7.6% | 19.7% | 14/29 | 260 ms |
| Qwen3-ASR 0.6B | 4.9% | 27.4% | **20/29** | 220 ms |
| Omnilingual 300M | 20% | 28% | 8/29 | 160 ms |

- **Turkish:** Whisper turbo is clearly the best. It's also the only one that handled mixed Turkish/English sentences reasonably (14% errors; the others were over 50%).
- **Cost:** on CPU it's about 8× slower than Parakeet. A Metal-accelerated build (whisper.cpp) should bring that well under the current speed, and I'll check that next.
- **The real catch:** every model struggles with "Atlas" on your recordings, so the wake-word fix in #39 matters more than which speech model we pick.
- **One thing to check:** these error rates are only as good as my clip extraction. I'll make sure none of the FLEURS clips got cut off in the download before I trust the numbers.

**Text-to-speech.** I've rendered the same English and Turkish lines with 37 voice/model combinations: Kokoro (10 voices), Supertonic 3 (10 voices, speaks Turkish), Pocket TTS (Kyutai, can copy a voice from a short sample, fastest at about 240 ms to first audio), Kitten, three Piper Turkish voices, and macOS `say` as a baseline. I can't listen to them myself. To check they're understandable, I ran them back through speech-to-text, and Qwen3 got 97% of Pocket/Kokoro English words right.

**Next:**
1. A listening page with play buttons, time to first audio and size for each voice.
2. `docs/voice-models.md` with my recommendation.
3. Then I'll block the card so you can listen and pick, and record a few real Turkish sentences.

I haven't changed anything in the app.