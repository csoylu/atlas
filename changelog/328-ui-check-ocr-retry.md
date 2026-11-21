## Fixed · #328 · ui-check no longer fails a label that Vision drops from the page and from one crop, as in the agent sandbox on Settings → Secrets

Apple Vision gave nothing for the description « Ethereum mainnet JSON-RPC (Alchemy)… » (drawn fine, read at once on other machines) on the full page and on the one 24 px crop of its box, so every `--only settings-secrets` run failed in one sandbox. A label with no OCR line is now read again with a margin of 8, 0 and 60 px; text that stays empty after every margin still fails. Test tooling only: the page is unchanged.
