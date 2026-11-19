## Fixed · #255 · The voice end-to-end test no longer fails by chance, so `npm run test:full` can be trusted again for voice work

`voiceLoop.test.ts` failed about once in five runs on a quiet machine, never from the voice loop itself: the barge-in
never missed a stop word in ~75 runs (cut after 150–700 ms). The failures were exact-transcript assertions on real
speech models that read the same audio differently from run to run: Supertonic renders « Yes, Master? » with new noise
each time and Whisper wrote « Yesta. » or « Yes, Moss. » (3 of 40 syntheses), « Yeter. Y » / « Hayyuz. Hayy » after a
stop word, and « kartaş » for « kart aç ».

The tests now run the scenario again (kit `retry`, only on that reading, named in the log) when Whisper did not hear
what the scenario needs, and the Turkish command check accepts both readings; what they assert is unchanged. The
sleep loop became the kit's `eventually`. Two real weaknesses found on the way (a stop word followed by a cut-off
token, and a misheard « Yes, Master? » echo, both sent to the chat) are task #257. The Tests how-to in CLAUDE.md says
how to write voice tests.
