# Office automation (Word COM)

End-to-end verified pattern; Excel, PowerPoint and Outlook expose the same Application/Documents COM model.

The `.ps1` must run from a Windows-visible path, so copy it into the user temp dir first:

```bash
TMPWIN=$(powershell.exe -NoProfile -Command "[Environment]::GetEnvironmentVariable('TEMP')" | tr -d '\r\n')
TMPLIN=$(echo "$TMPWIN" | sed 's|C:\\|/mnt/c/|; s|\\|/|g')
cp script.ps1 "$TMPLIN/"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$TMPWIN\\script.ps1"
```

Kill any prior Word instance first, otherwise `Documents.Add()` appends to the running one:

```powershell
Stop-Process -Name WINWORD -Force
$word = New-Object -ComObject Word.Application
$word.Visible = $true
$word.WindowState = 2          # minimize so it does not disturb the user
$doc = $word.Documents.Add()
$sel = $word.Selection
```

## Core building blocks (all verified)

- Styles: `$sel.Style = $doc.Styles.Item('Title'|'Subtitle'|'Heading 1')`; formatting via `$sel.Font.Size/Bold/Italic/Color`; colors are BGR: `$r + $g*256 + $b*65536`.
- Text: `$sel.TypeText('...')`, `$sel.TypeParagraph()`, `$sel.InsertBreak(7)` (page break). `$sel.EndKey(6)` jumps to story end but returns a Long — suppress with `$null =` to keep output clean.
- Lists: `$sel.Range.ListFormat.ApplyBulletDefault()`; `$sel.Range.ListFormat.RemoveNumbers(1)` after.
- Symbols: `$sel.InsertSymbol(252, 'Wingdings', $false, 0)` for dingbats; other glyphs as Unicode codepoints in pure-ASCII script: `[char]0x2713`, surrogate pairs via `[char]::ConvertFromUtf32(0x1F600)`.
- Picture: `$doc.InlineShapes.AddPicture("$tmp\img.png", $false, $true)`; generate the PNG with System.Drawing (`Add-Type -AssemblyName System.Drawing`, Bitmap + Graphics, `$bmp.Save(..., [System.Drawing.Imaging.ImageFormat]::Png)`).
- Table: `$tbl = $doc.Tables.Add($sel.Range, rows, cols)`; fill `$tbl.Cell(r,c).Range.Text`; shade headers via `$tbl.Cell(1,1).Range.Shading.BackgroundPatternColor`.
- Floating shapes: WordArt `$doc.Shapes.AddTextEffect(11, 'text', 'Impact', 36, $false, $false, x, y)`; text box `$doc.Shapes.AddTextbox(1, x, y, w, h)` then `.TextFrame.TextRange.Text`.
- Header/footer: `$doc.Sections.Item(1).Headers.Item(1).Range.Text`; page-number field `$doc.Fields.Add($doc.Sections.Item(1).Footers.Item(1).Range, 33)`.
- Save: `$doc.SaveAs2("$tmp\out.docx", 16)` (16 = docx) and `$doc.ExportAsFixedFormat("$tmp\out.pdf", 17)` (17 = PDF).
- Attach to a running instance: `$w = [Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application')` (e.g. to minimize it from a later shell).

## Word COM quirks (observed)

- With PS 5.1 late binding (no interop PIA), `OMath.BuildUp()` is unresolvable — `DISP_E_UNKNOWNNAME` both as a direct call and via `InvokeMember`. `$doc.OMaths.Add($range)` still inserts a valid linear equation, which is acceptable.
- After `OMaths.Add`, the selection sits inside a math zone and formatting (e.g. `Font.Superscript`) throws COMException `0x800A1863`. Always `$null = $sel.EndKey(6)` to exit the zone before further formatting.
- Multi-argument COM methods (`SaveAs2`, `ExportAsFixedFormat`) work positionally with omitted optional args under PS 5.1 late binding.