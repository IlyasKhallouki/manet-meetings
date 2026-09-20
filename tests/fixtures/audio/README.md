# Speech fixtures

Real human speech for the Gemini transcription tests (`speech-*.webm`). No
text-to-speech engine was available, so the clips are cut from public-domain
LibriVox audiobooks.

| File | Content | Duration | Size |
|---|---|---|---|
| `speech-en.webm` | English excerpt | 40.2 s | 167 KB |
| `speech-fr.webm` | French excerpt | 40.2 s | 170 KB |
| `speech-mixed.webm` | `speech-en` then `speech-fr` (English 0 to 40.2 s, French 40.2 to 80.4 s) | 80.4 s | 349 KB |

All three are mono Opus in WebM (48 kHz, 32 kb/s), like the extension's recordings.

## Sources and licence

LibriVox recordings are in the public domain (archive.org lists the licence as
`http://creativecommons.org/licenses/publicdomain/`). The book texts are public
domain too.

- English: *The Adventures of Sherlock Holmes* by Sir Arthur Conan Doyle, read by
  Mark F. Smith. Track "01 - A Scandal in Bohemia", 64 kb/s MP3:
  https://archive.org/download/adventures_sherlockholmes_1007_librivox/adventuresherlockholmes_01_doyle_64kb.mp3
  (item page: https://archive.org/details/adventures_sherlockholmes_1007_librivox)
- French: *Le tour du monde en quatre-vingts jours* by Jules Verne, LibriVox group
  recording. Track "01 - Tour du monde Jules Verne", 64 kb/s MP3:
  https://archive.org/download/tour_du_monde_en_80_jours_librivox/tour_monde_01_verne_64kb.mp3
  (item page: https://archive.org/details/tour_du_monde_en_80_jours_librivox)

## How they were made

Each clip is the first 40.2 s of its track. The cut falls in a pause (measured
from 100 ms RMS windows), so no word is split. A 60 Hz high-pass removes a DC
offset in the French track.

```sh
ffmpeg -i en.mp3 -t 40.2 -af highpass=f=60 -ac 1 -c:a libopus -b:a 32k speech-en.webm
ffmpeg -i fr.mp3 -t 40.2 -af highpass=f=60 -ac 1 -c:a libopus -b:a 32k speech-fr.webm
ffmpeg -t 40.2 -i en.mp3 -t 40.2 -i fr.mp3 -filter_complex \
  "[0:a]highpass=f=60,aresample=48000[a];[1:a]highpass=f=60,aresample=48000[b];[a][b]concat=n=2:v=0:a=1[out]" \
  -map "[out]" -ac 1 -c:a libopus -b:a 32k speech-mixed.webm
```

## Reference text

Nobody has checked these clips word for word by ear: no speech recognizer was
available offline. The text below is the standard LibriVox preamble plus the
opening of each book (Project Gutenberg #1661 and #800), so tests should assert
only on the distinctive words listed under each excerpt, never on exact wording.

English, 0 to 40.2 s. About 0 to 30 s is the LibriVox preamble, then a pause (about
30 to 33 s), then the story begins:

> A Scandal in Bohemia, [from] The Adventures of Sherlock Holmes by Sir Arthur
> Conan Doyle. This is a LibriVox recording. All LibriVox recordings are in the
> public domain. For more information or to volunteer, please visit librivox.org.
> […] To Sherlock Holmes she is always the woman. I have seldom heard him mention
> her under any other name. […]

Distinctive words: **Sherlock**, **Holmes**, **LibriVox**, Bohemia, Doyle.

French, 0 to 40.2 s (40.2 to 80.4 s in `speech-mixed.webm`). About 0 to 30 s is the
LibriVox preamble, then a pause (about 30 to 32.6 s), then chapter I begins:

> [Chapitre premier du] Tour du monde en quatre-vingts jours, de Jules Verne.
> [Ceci est un enregistrement LibriVox. Tous les enregistrements LibriVox sont
> dans le domaine public.] […] Dans lequel Phileas Fogg et Passepartout
> s'acceptent réciproquement, l'un comme maître, l'autre comme domestique. […]

Distinctive words: **Verne**, **monde**, **LibriVox**, Phileas, Fogg, Passepartout.

The bracketed passages are the usual LibriVox wording; the reader may phrase them
a little differently.
