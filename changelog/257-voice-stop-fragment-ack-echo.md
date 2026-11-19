## Fixed · #257 · Voice no longer sends a cut-off stop word (« Yeter. Y ») or a misheard echo of « Yes, Master? » (« Yesta. ») to the chat as a command.
- After a barge-in, a word that repeats the start of the stop word before it (the audio cut mid-word) counts as part of the stop: « Hayyuz. Hayy » stays quiet, « stop, go on » is still sent.
- Within 2.5 s of « Yes, Master? », a short utterance starting with « yes » (at most 2 short words) is treated as its echo. Later, Master's « yes » is sent, even alone (it used to be dropped).
