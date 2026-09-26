// Copyright (c) 2026 TechLead 187 LLC
// SPDX-License-Identifier: BUSL-1.1
import { Resvg } from '@resvg/resvg-js';
import { MASCOT_FRAMES, MASCOT_PALETTE, MASCOT_RUN_FRAMES } from '../renderer/mascot.ts';
const result = await Bun.build({ entrypoints: [import.meta.dir + '/preview.ts'], target: 'browser', minify: true });
if (!result.success) throw new Error(result.logs.join('\n'));
const js = await result.outputs[0]!.text();
const html = await Bun.file(import.meta.dir + '/preview.html').text();
await Bun.write(import.meta.dir + '/review.html', html.replace('<script src="preview.js"></script>', '<script>' + js.replace(/<\/script/gi, '<\\/script') + '</script>'));
for (const [name, ids] of [['gait', MASCOT_RUN_FRAMES], ['combat', ['punchA', 'punchB', 'punchC', 'punchD', 'kickA', 'kickB', 'kickC', 'kickD']]] as const) {
  let svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 332"><rect width="480" height="332" fill="#14202c"/>';
  ids.forEach((id, i) => {
    const x = 20 + i % 4 * 120, y = 20 + Math.floor(i / 4) * 160;
    svg += `<g transform="translate(${x} ${y}) scale(2.3)" shape-rendering="crispEdges">`;
    const frame = MASCOT_FRAMES[id]!;
    for (const [symbol, color] of Object.entries(MASCOT_PALETTE)) {
      let d = '';
      frame.forEach((row, yy) => { for (let xx = 0; xx < row.length; xx++) if (row[xx] === symbol) d += `M${xx} ${yy}h1v1h-1z`; });
      if (d) svg += `<path fill="${color}" d="${d}"/>`;
    }
    svg += `</g><text x="${x + 44}" y="${y + 140}" text-anchor="middle" fill="#c6dded" font-size="12" font-family="monospace">${id}</text>`;
  });
  svg += '</svg>';
  await Bun.write(import.meta.dir + '/' + name + '.svg', svg);
  await Bun.write(import.meta.dir + '/' + name + '.png', new Resvg(svg, { fitTo: { mode: 'width', value: 960 } }).render().asPng());
}
console.log('Built self-contained review.html and contact sheets from production sprite modules');
