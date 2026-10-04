# Third-party notices

LUCID's first-party code is BUSL-1.1 (see `LICENSE`). The files listed below contain code PORTED
(translated to TypeScript and modified) from permissively licensed projects. Each ported file keeps the
upstream copyright line and license text in its header; the notices are repeated here as the licenses
require. npm dependencies keep their own licenses inside `node_modules/` and are not listed here.

## Ported source

| LUCID file | Upstream | License | Copyright |
|---|---|---|---|
| `harness/creator/design/freehand.ts` | perfect-freehand, https://github.com/steveruizok/perfect-freehand (`packages/perfect-freehand/src/`) | MIT | Copyright (c) 2021 Stephen Ruiz Ltd |
| `harness/creator/design/fit.ts` | fit-curve, https://github.com/soswow/fit-curve (`src/fit-curve.js`) | MIT | Copyright (c) 2014 Volker Poplawski |
| `harness/creator/design/fit.ts` (algorithm) | Philip J. Schneider, "An Algorithm for Automatically Fitting Digitized Curves", Graphics Gems, Academic Press, 1990 | Graphics Gems EULA | Graphics Gems authors |
| `harness/creator/design/trace.ts` | imagetracerjs 1.2.6, https://github.com/jankovicsandras/imagetracerjs (`imagetracer_v1.2.6.js`) | Unlicense (public domain) | András Jankovics (dedicated to the public domain) |

### perfect-freehand (MIT)

```
MIT License

Copyright (c) 2021 Stephen Ruiz Ltd

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### fit-curve (MIT)

```
The MIT License (MIT)

Copyright (c) 2014 Volker Poplawski

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Graphics Gems (EULA, https://github.com/erich666/GraphicsGems/blob/master/LICENSE.md)

```
EULA: The Graphics Gems code is copyright-protected. In other words, you cannot claim the text of the
code as your own and resell it. Using the code is permitted in any program, product, or library,
non-commercial or commercial. Giving credit is not required, though is a nice gesture. The code comes
as-is, and if there are any flaws or problems with any Gems code, nobody involved with Gems - authors,
editors, publishers, or webmasters - are to be held responsible. Basically, don't be a jerk, and
remember that anything free comes with no guarantee.
```

### imagetracerjs (Unlicense)

```
The Unlicense / PUBLIC DOMAIN

This is free and unencumbered software released into the public domain.

Anyone is free to copy, modify, publish, use, compile, sell, or
distribute this software, either in source code form or as a compiled
binary, for any purpose, commercial or non-commercial, and by any
means.

In jurisdictions that recognize copyright laws, the author or authors
of this software dedicate any and all copyright interest in the
software to the public domain. We make this dedication for the benefit
of the public at large and to the detriment of our heirs and
successors. We intend this dedication to be an overt act of
relinquishment in perpetuity of all present and future rights to this
software under copyright law.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR
OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.

For more information, please refer to http://unlicense.org/
```

## Implemented natively from public specifications (no code copied)

These `harness/creator/design/` modules were written from the specifications below; they are listed for
provenance only.

- `blend.ts`: W3C Compositing and Blending Level 1 (https://www.w3.org/TR/compositing-1/).
- `anim.ts`: W3C CSS Easing Functions Level 1 (https://www.w3.org/TR/css-easing-1/).
- `path.ts`: W3C SVG 2 path grammar and arc implementation notes (https://www.w3.org/TR/SVG2/).
- `gif.ts`: GIF89a (https://www.w3.org/Graphics/GIF/spec-gif89a.txt); the palette quantizer is native.
  gifenc's `pnnquant2.js` was NOT ported: it is "Modified from" mcychan/PnnQuant.js, which is MPL-2.0.
- `apng.ts`, `png_stream.ts`: PNG (W3C, 3rd edition) and the APNG specification.
- `psd.ts`: Adobe Photoshop File Formats Specification (format documentation only; no Adobe code, SDK, or
  library is used).
