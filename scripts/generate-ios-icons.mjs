import sharp from 'sharp';
import fs from 'fs';
import path from 'path';

const svgIcon = `
<svg width="512" height="512" viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg">
  <!-- Solid Obsidian Background (Required by iOS - No Transparency) -->
  <rect width="512" height="512" fill="#090d16"/>
  <!-- Subtle Inner Quant Grid Border -->
  <rect x="24" y="24" width="464" height="464" rx="96" stroke="#10b981" stroke-opacity="0.18" stroke-width="6"/>
  <!-- Neon Green PropWire P + Upward Trend Mark -->
  <path d="M148 384V140H268C316 140 348 168 348 214C348 260 316 288 268 288H204V384H148ZM204 240H262C282 240 294 230 294 214C294 198 282 188 262 188H204V240Z" fill="#84cc16"/>
  <!-- Upward Breakout Arrow Accent -->
  <path d="M276 340L376 240M376 240H308M376 240V308" stroke="#22c55e" stroke-width="36" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const dirs = ['viewer', 'public'];
for (const dir of dirs) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  await sharp(Buffer.from(svgIcon)).resize(180, 180).png().toFile(path.join(dir, 'apple-touch-icon.png'));
  await sharp(Buffer.from(svgIcon)).resize(180, 180).png().toFile(path.join(dir, 'apple-touch-icon-precomposed.png'));
  await sharp(Buffer.from(svgIcon)).resize(192, 192).png().toFile(path.join(dir, 'icon-192.png'));
  await sharp(Buffer.from(svgIcon)).resize(512, 512).png().toFile(path.join(dir, 'icon-512.png'));
  await sharp(Buffer.from(svgIcon)).resize(32, 32).png().toFile(path.join(dir, 'favicon-32x32.png'));
}

console.log('✔ Generated iOS apple-touch-icon.png (180x180) and PWA icons in viewer/ and public/');
