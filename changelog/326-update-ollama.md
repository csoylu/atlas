## Added · #326 · Settings → Local models can update a Homebrew Ollama, and a model that needs a newer Ollama offers the update instead of a wrong hint

### Details
- « Ollama on this machine » has an « Update » button next to Stop when Ollama was installed with Homebrew. It refreshes Homebrew's formulae, runs `brew upgrade ollama` and restarts the server: Atlas's own server is restarted by Atlas, a `brew services` one by brew. Then it shows the new version. The old server keeps running during the upgrade, so a failure leaves it as it was and shows brew's error.
- When the page opens, Atlas asks Homebrew (`brew info`) for the newest version it knows and shows « 0.41.2 available ». It never checks in the background.
- Loaded models are unloaded by the restart: the confirm names them. Updating is refused while a model downloads, and a download is refused while Ollama updates.
- A download that fails with Ollama's 412 (« requires a newer version of Ollama ») now says « This model needs a newer Ollama » with an « Update Ollama » button. After the update the download starts again by itself. Before, the error ended with « check the name on ollama.com/library », which was wrong advice here.
- An Ollama not installed by Homebrew (the Ollama app, a manual binary) gets no button, only « Update Ollama from ollama.com/download ».
