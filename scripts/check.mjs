import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1');

function files(directory) {
    return readdirSync(directory).flatMap(name => {
        const path = join(directory, name);
        if (name === '.git' || name === 'node_modules') return [];
        return statSync(path).isDirectory() ? files(path) : [path];
    });
}

for (const file of files(root).filter(path => /\.(?:js|mjs)$/.test(path))) {
    execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
    console.log(`checked ${relative(root, file)}`);
}

const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
for (const required of ['display_name', 'js', 'css', 'version', 'minimum_client_version']) {
    if (!manifest[required]) throw new Error(`manifest.json missing ${required}`);
}
for (const referenced of [manifest.js, manifest.css, ...Object.values(manifest.i18n ?? {})]) {
    if (!existsSync(join(root, referenced))) throw new Error(`manifest.json references missing file: ${referenced}`);
}
console.log('checked manifest.json');
