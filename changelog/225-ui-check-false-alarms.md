## Fixed · #225 · The UI check no longer cries wolf on « Links », « task not found » banners and « Failed to fetch », and now catches header text drawn over header text

ui-check (`scripts/ui-check/check.mjs`): the OCR comparison treats `i`, `I` and `l` as one letter (« Links » read as « LInks »); fixture tasks answer every request the thread asks for them; opening an Inbox update gets a fake « marked read »; an error banner on any screen and two overlapping text boxes in a header are issues. The check would have caught #224's « Tasks » / « All tasks » overlap at 390 px.
