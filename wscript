#
# Build rules for Pointer Planetarium (one watchapp plus its phone-side JS).
#
import os

top = '.'
out = 'build'


def options(ctx):
    ctx.load('pebble_sdk')


def configure(ctx):
    ctx.load('pebble_sdk')


def build(ctx):
    ctx.load('pebble_sdk')

    binaries = []
    cached_env = ctx.env
    for platform in ctx.env.TARGET_PLATFORMS:
        ctx.env = ctx.all_envs[platform]
        ctx.set_group(ctx.env.PLATFORM_NAME)
        shot = os.environ.get('SKY_SHOT')   # screenshot harness, compiled out of normal builds
        if shot:
            ctx.env.append_value('CFLAGS', '-DSKY_SHOT=' + shot)
            if os.environ.get('SKY_TOUCH'):
                ctx.env.append_value('CFLAGS', '-DSKY_TOUCH')
        # Link-time optimisation: the whole app optimised as one, about 3 KB
        # smaller (the image is capped at 65,535 bytes, tools/size_report.py).
        # The app's header (__pbl_app_info, appinfo.auto.c) is wanted only by
        # the linker script, which link-time optimisation doesn't see: without
        # -u it's thrown away and the watch won't install the app.
        ctx.env.append_value('CFLAGS', '-flto')
        ctx.env.append_value('LINKFLAGS', ['-flto', '-Wl,-u,__pbl_app_info'])
        app_elf = '{}/pebble-app.elf'.format(ctx.env.BUILD_DIR)
        ctx.pbl_build(source=ctx.path.ant_glob('src/c/**/*.c'), target=app_elf, bin_type='app')
        binaries.append({'platform': platform, 'app_elf': app_elf})
    ctx.env = cached_env

    ctx.set_group('bundle')
    ctx.pbl_bundle(binaries=binaries,
                   js=ctx.path.ant_glob(['src/pkjs/**/*.js', 'src/pkjs/**/*.json']),
                   js_entry_file='src/pkjs/index.js')
