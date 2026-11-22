## Changed · #342 · The last canvas conversion code is gone; old canvas steps in chats now show as plain steps

Canvases became html pages in the « Canvases » folder in #120. The start-up converter (`canvasPage.ts`,
`Documents.convertCanvases`), the chat lookup that turned an old `canvas_*` step into the chip of its converted page,
the `fromCanvas` field and the `#/settings/canvas` redirect are removed. The converted pages stay in the Library as
ordinary html artifacts; old chats keep their canvas steps as plain rows, without a link to the page.
