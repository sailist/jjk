import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(repoRoot);

const require = createRequire(path.join(repoRoot, 'package.json'));
const esbuild = require('esbuild');

const PRODUCTION = process.argv.includes('--production');

const WEB_DIR = path.join('src', 'graphPanel', 'web');
const STYLES_DIR = path.join(WEB_DIR, 'styles');
const OUTPUT_DIR = path.join('dist', 'graph');

const TYPES_FILE = path.join('src', 'graphPanel', 'types.ts');
const JS_FILES = [
	'utils.ts',
	'contextMenu.ts',
	'dialog.ts',
	'dropdown.ts',
	'findWidget.ts',
	'textFormatter.ts',
	'graph.ts',
	'settingsWidget.ts',
	'main.ts'
];

console.log('Packaging Mode = ' + (PRODUCTION ? 'PRODUCTION' : 'DEBUG'));
console.log('Packaging JS files: ' + [TYPES_FILE, ...JS_FILES.map((file) => path.join(WEB_DIR, file))].join(', '));

let jsContents = 'namespace GG {\n' + fs.readFileSync(TYPES_FILE, 'utf8') + '\n}\n';
for (const file of JS_FILES) {
	jsContents += fs.readFileSync(path.join(WEB_DIR, file), 'utf8') + '\n';
}

const jsResult = await esbuild.transform(jsContents, {
	loader: 'ts',
	target: 'es2018',
	minify: PRODUCTION
});
jsResult.code = '"use strict";\n(function(document, window){\n' + jsResult.code + '\n})(document, window);\n';

const cssFiles = fs.readdirSync(STYLES_DIR).filter((file) => file.endsWith('.css')).sort();
const orderedCssFiles = ['main.css', ...cssFiles.filter((file) => file !== 'main.css')];
console.log('Packaging CSS files: ' + orderedCssFiles.map((file) => path.join(STYLES_DIR, file)).join(', '));

let cssContents = '';
for (const file of orderedCssFiles) {
	cssContents += fs.readFileSync(path.join(STYLES_DIR, file), 'utf8') + '\n';
}

if (PRODUCTION) {
	cssContents = (await esbuild.transform(cssContents, { loader: 'css', minify: true })).code;
}

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUTPUT_DIR, 'main.js'), jsResult.code);
fs.writeFileSync(path.join(OUTPUT_DIR, 'main.css'), cssContents);

console.log('Wrote ' + path.join(OUTPUT_DIR, 'main.js') + ' (' + jsResult.code.length + ' bytes)');
console.log('Wrote ' + path.join(OUTPUT_DIR, 'main.css') + ' (' + cssContents.length + ' bytes)');
