# How much of the watch's room a built app uses, from the .pbw itself: the
# app image against the 65,535 bytes PebbleProcessInfo can describe, and
# the resources against the app store's limit. Markdown on stdout, for the
# CI job summary and the release notes.
# Run: python3 tools/size_report.py build/*.pbw
#
# The image is checked twice by the SDK (inject_metadata.py): load_size
# (.text + .data, what is copied in) and virtual_size (that plus .bss, the
# zeroed statics) are both uint16_t in the app header, so each must be
# 65,535 or less whatever RAM the platform has. virtual_size is the larger,
# so it is the one that runs out. Heap (malloc) doesn't count towards it.
import json, struct, sys, zipfile

LIMIT = 0xFFFF
LOAD_SIZE_AT = 0x0E      # PebbleProcessInfo offsets (inject_metadata.py)
RELOCS_AT = 0x64
VIRTUAL_SIZE_AT = 0x80
RESOURCES_LIMIT = {      # MAX_RESOURCES_SIZE_APPSTORE (pebble_sdk_platform.py)
    'aplite': 0x20000, 'basalt': 0x40000, 'chalk': 0x40000, 'diorite': 0x40000,
    'emery': 0x40000, 'flint': 0x40000, 'gabbro': 0x40000,
}
WARN_AT = 0.90           # flag the image once it is this full


def bar(used, total, width=20):
    n = min(width, round(width * used / total))
    return '`' + '#' * n + '.' * (width - n) + '`'


def row(name, used, total):
    return '| %s | %s | %s | %.1f%% %s |' % (name, f'{used:,}', f'{total:,}', 100 * used / total,
                                           bar(used, total))


def report(pbw):
    out, warnings = [], []
    with zipfile.ZipFile(pbw) as z:
        names = set(z.namelist())
        info = json.loads(z.read('appinfo.json'))
        out.append('### App size (%s %s)' % (info.get('longName') or info.get('shortName', ''),
                                             info.get('versionLabel', '')))
        out.append('')
        out.append('| | Used (bytes) | Limit (bytes) | |')
        out.append('|---|---:|---:|---|')
        for platform in info.get('targetPlatforms', []):
            binary = platform + '/pebble-app.bin'
            if binary not in names:
                continue
            head = z.read(binary)[:VIRTUAL_SIZE_AT + 2]
            load = struct.unpack_from('<H', head, LOAD_SIZE_AT)[0]
            virtual = struct.unpack_from('<H', head, VIRTUAL_SIZE_AT)[0]
            relocs = struct.unpack_from('<L', head, RELOCS_AT)[0]
            out.append(row('%s app image (code + data + statics)' % platform, virtual, LIMIT))
            out.append(row('%s ... code + data only' % platform, load, LIMIT))
            if virtual > WARN_AT * LIMIT:
                warnings.append('%s app image is %d of %d bytes (%.0f%%)' % (platform, virtual, LIMIT,
                                                                              100 * virtual / LIMIT))
            res = platform + '/app_resources.pbpack'
            if res in names and platform in RESOURCES_LIMIT:
                out.append(row('%s resources' % platform, z.getinfo(res).file_size, RESOURCES_LIMIT[platform]))
            out.append('')
            out.append('%s: statics (.bss) %s bytes, %d relocations. Free for more code: %s bytes.' % (
                platform, f'{virtual - load:,}', relocs, f'{LIMIT - virtual:,}'))
            out.append('')
        if 'pebble-js-app.js' in names:
            out.append('Phone-side JS: %s bytes (runs on the phone; no watch limit).' %
                       f'{z.getinfo("pebble-js-app.js").file_size:,}')
    return '\n'.join(out) + '\n', warnings


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit('usage: python3 tools/size_report.py <app.pbw>')
    text, warnings = report(sys.argv[1])
    sys.stdout.write(text)
    for w in warnings:
        sys.stderr.write('::warning title=App image nearly full::%s\n' % w)
