import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1');

function files(directory) {
    return readdirSync(directory).flatMap(name => {
        const path = join(directory, name);
        if (name === '.git' || name === 'node_modules') return [];
        return statSync(path).isDirectory() ? files(path) : [path];
    });
}

const projectFiles = files(root);
const scriptFiles = projectFiles.filter(path => /\.(?:js|mjs)$/.test(path));

for (const file of scriptFiles) {
    execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
    console.log(`checked ${relative(root, file)}`);
}

// 源码注释保持标准块格式，避免接口契约退化为难读的单行注释
for (const file of scriptFiles) {
    const source = readFileSync(file, 'utf8');
    if (/\/\*\*[^\r\n]*\*\//.test(source)) {
        throw new Error(`JSDoc 必须使用多行格式：${relative(root, file)}`);
    }
}

// 嵌套模板节点分行排列，避免图标、文案和控件挤在同一行
for (const file of projectFiles.filter(path => path.endsWith('.html'))) {
    const source = readFileSync(file, 'utf8');
    if (/<\/[^>]+>[\t ]*</.test(source)) {
        throw new Error(`HTML 相邻子节点必须分行：${relative(root, file)}`);
    }
}

const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
for (const required of ['display_name', 'js', 'css', 'version', 'minimum_client_version', 'homePage']) {
    if (!manifest[required]) throw new Error(`manifest.json missing ${required}`);
}
if (manifest.version !== packageJson.version) {
    throw new Error('manifest.json and package.json versions do not match');
}
if (manifest.auto_update !== true) {
    throw new Error('manifest.json must enable SillyTavern update checks');
}
for (const referenced of [
    manifest.js,
    manifest.css,
    'templates/settings.html',
    'templates/panel.html',
    'templates/data-maid-enhancer.html',
    'templates/dialogs.html',
    'templates/components.html',
    ...Object.values(manifest.i18n ?? {}),
]) {
    if (!existsSync(join(root, referenced))) throw new Error(`插件引用了不存在的文件：${referenced}`);
}

// 样式入口中的相对导入必须随插件一起发布
const cssEntryPath = join(root, manifest.css);
const cssEntry = readFileSync(cssEntryPath, 'utf8');
for (const match of cssEntry.matchAll(/@import\s+url\(["']?([^"')]+)["']?\)\s*;/g)) {
    const importedPath = resolve(dirname(cssEntryPath), match[1]);
    if (!existsSync(importedPath)) throw new Error(`样式入口引用了不存在的文件：${match[1]}`);
}
console.log('checked manifest.json');
