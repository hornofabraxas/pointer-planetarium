// The settings page on the phone, as one HTML string (index.js opens it as
// a data: URL, so everything is inline: no fonts or pictures to fetch at a
// dark site with no signal). Plain words first; the technical ones only
// where they're needed, with what they mean.
//
// Three tabs: Settings, the Logbook (a collection: shelves of what you've
// seen, drawn with the watch's own pictures and icons) and About (the
// logbook to copy, credits). Save and Close sit under all three.
//
// build(s) takes everything the page shows (index.js gathers it):
//   red: Stargazer colours (the watch is red now, so the phone shouldn't
//     blind you either); tonight: a line about tonight, or '';
//   sky ('city'|'suburbs'|'dark'), show (find.SHOW: 'eye'|'binoculars'|'all');
//   light (index.js LIGHT: 'read30'|'read60'|'finding'|'watch');
//   planes {on, minFt, maxKm, source, rx}, minFtChoices, maxKmChoices, metric;
//   sats {stations, visual, trains, hidden}, satAgo {stations, visual, trains}
//     ("Updated 3 h ago");
//   facts, units ('auto'|'imperial'|'metric');
//   aimLines: [html <li>s]; credits ([text, link] or text); sunEye, sunAided
//   (find.js); logbook: collection.js's view, plus on (noting roughly
//   where) and csv.
// What Save sends back is read by index.js's webviewclosed. The buttons
// that undo something (start learning again, put every setting back,
// clear the logbook) ask for a second tap, then save at once.

var ART = require('./page_art.js');
var CRAFT = require('./craft_svg.js');

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                  .replace(/"/g, '&quot;');
}

// The watch's icons (main.c draw_icon), in the same units: about 24 from
// the middle to the edge. In the text colour, so they turn red with the page.
function icon(body, cls) {
  return '<svg class="' + (cls || 'ic') + '" viewBox="-26 -26 52 52" aria-hidden="true">' + body + '</svg>';
}
function poly(pts) {
  return '<polygon points="' + pts.map(function (p) { return p[0] + ',' + p[1]; }).join(' ') + '"/>';
}
var PLANE = [[0, -24], [4, -18], [4, -6], [24, 6], [24, 10], [4, 4], [4, 16], [10, 22], [10, 24], [0, 22],
             [-10, 24], [-10, 22], [-4, 16], [-4, 4], [-24, 10], [-24, 6], [-4, -6], [-4, -18]];
var STAR = [[0, -22], [7, -7], [23, -5], [11, 6], [14, 22], [0, 14], [-14, 22], [-11, 6], [-23, -5], [-7, -7]];
var ICONS = {
  plane: icon('<g fill="currentColor">' + poly(PLANE) + '</g>'),
  star: icon('<g fill="currentColor">' + poly(STAR) + '</g>'),
  // Two panels of four, with gaps between (not lines drawn over them, which
  // would have to match whatever is behind).
  satellite: icon('<g fill="currentColor"><rect x="-5" y="-3" width="10" height="11"/>' +
                  '<circle cx="0" cy="-14" r="4"/>' + [-24, -15.25, 9, 17.75].map(function (x) {
                    return '<rect x="' + x + '" y="-6" width="7.25" height="9.25"/><rect x="' + x +
                           '" y="4.75" width="7.25" height="9.25"/>';
                  }).join('') + '</g><path d="M-9 4H9M0-2V-12" stroke="currentColor" stroke-width="1.5"/>'),
  planet: icon('<circle r="13" fill="currentColor"/><ellipse rx="24" ry="7" fill="none" stroke="currentColor" ' +
               'stroke-width="3" transform="rotate(-20)"/>'),
  // The watch's disc with a bite out of it, as one shape (no mask, so no id
  // repeated down the page): the circle of 19 outside the one of 17 at (10, -5).
  moon: icon('<path fill="currentColor" d="M0.35 -18.99A19 19 0 1 0 15.41 11.11A17 17 0 0 1 0.35 -18.99Z"/>'),
  constellation: icon('<path d="M-20 12L-6-4L8 4L20-16" fill="none" stroke="currentColor" stroke-width="2"/>' +
                      '<g fill="currentColor"><circle cx="-20" cy="12" r="4"/><circle cx="-6" cy="-4" r="4"/>' +
                      '<circle cx="8" cy="4" r="4"/><circle cx="20" cy="-16" r="4"/></g>')
};

function toggle(id, label, on, note) {
  return '<label class="sw"><span>' + label + (note ? '<br><span class="note">' + note + '</span>' : '') +
         '</span><input type="checkbox" id="' + id + '"' + (on ? ' checked' : '') + '></label>';
}

function option(v, label, cur) {
  return '<option value="' + v + '"' + (String(v) === String(cur) ? ' selected' : '') + '>' + label + '</option>';
}

// A dropdown with its label above it (for choices too long to sit beside it).
function field(id, label, cur, opts) {
  return '<label class="field"><span>' + label + '</span><select id="' + id + '">' +
         opts.map(function (o) { return option(o[0], o[1], cur); }).join('') + '</select></label>';
}

// A dropdown beside its label.
function row(id, label, cur, opts) {
  return '<div class="row">' + label + ' <select id="' + id + '">' +
         opts.map(function (o) { return option(o[0], o[1], cur); }).join('') + '</select></div>';
}

// A button that undoes something: the first tap asks, the second saves.
function undo(key, label, note) {
  return '<div class="undo"><button type="button" class="danger" data-k="' + key + '" data-l="' + esc(label) +
         '" onclick="arm(this)">' + label + '</button>' + (note ? '<span class="note">' + note + '</span>' : '') +
         '</div>';
}

var CSS =
  ':root{--bg:#0d1430;--card:#172044;--line:#2e3a6e;--fg:#eef1fb;--mute:#a9b3d6;--acc:#ffd166;--ink:#1d1600;' +
  '--sel:#22305f;--dim:#4a5584}' +
  '.red{--bg:#000;--card:#160000;--line:#460000;--fg:#ff5545;--mute:#c0392b;--acc:#ff3b30;--ink:#000;' +
  '--sel:#2a0000;--dim:#5a0000}' +
  '*{box-sizing:border-box}' +
  'body{margin:0;padding:16px 16px 104px;background:var(--bg);color:var(--fg);' +
  'font:17px/1.45 ui-rounded,"SF Pro Rounded",-apple-system,system-ui,Roboto,sans-serif}' +
  'header{display:flex;gap:12px;align-items:center;color:var(--acc)}header .ic{width:36px;height:36px}' +
  'h1{font-size:26px;margin:0;color:var(--fg)}' +
  '.tonight{border:2px solid var(--line);border-radius:14px;padding:10px 14px;margin:12px 0 0}' +
  '.tabs{display:flex;gap:6px;margin:14px 0 16px;background:var(--card);border-radius:14px;padding:4px}' +
  '.tabs button{flex:1;border:0;background:none;color:var(--mute);padding:9px 4px;border-radius:10px}' +
  '.tabs button.on{background:var(--sel);color:var(--acc)}' +
  'section{background:var(--card);border-radius:18px;padding:16px;margin:0 0 16px}' +
  'h2{font-size:21px;margin:0 0 4px}' +
  'p{margin:6px 0 12px}.note{color:var(--mute);font-size:15px}' +
  '.sw{display:flex;justify-content:space-between;align-items:center;gap:14px;padding:10px 0;' +
  'border-top:1px solid var(--line)}' +
  '.sw input{-webkit-appearance:none;appearance:none;flex:none;width:52px;height:32px;margin:0;' +
  'border-radius:16px;background:var(--line);position:relative}' +
  '.sw input::after{content:"";position:absolute;top:3px;left:3px;width:26px;height:26px;' +
  'border-radius:50%;background:var(--fg);transition:left .15s}' +
  '.sw input:checked{background:var(--acc)}.sw input:checked::after{left:23px;background:var(--ink)}' +
  '.row{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:8px 0}' +
  '.field{display:block;padding:8px 0}.field span{display:block;margin-bottom:6px}.field select{width:100%}' +
  'select,input[type=url]{font:inherit;color:var(--fg);background:var(--bg);' +
  'border:2px solid var(--line);border-radius:10px;padding:8px}input[type=url]{width:100%;font-size:15px}' +
  'details{margin-top:8px}summary{color:var(--acc);font-weight:600;padding:8px 0}' +
  '.safe{border-left:4px solid var(--acc);border-radius:8px;background:var(--sel);padding:8px 12px;' +
  'margin-top:12px;font-size:15px}' +
  'ul{padding-left:20px;margin:6px 0}li{margin:4px 0;font-size:15px;color:var(--mute)}a{color:var(--acc)}' +
  'textarea{width:100%;height:35vh;font:11px monospace;background:var(--bg);color:var(--fg);' +
  'border:1px solid var(--line)}' +
  'button{font:inherit;font-weight:700;border-radius:12px;border:2px solid var(--line);' +
  'background:var(--card);color:var(--fg);padding:10px 16px}' +
  '.undo{display:flex;flex-direction:column;gap:6px;align-items:flex-start;padding:10px 0;' +
  'border-top:1px solid var(--line)}.danger{color:var(--acc)}' +
  '.danger.armed{background:var(--acc);border-color:var(--acc);color:var(--ink)}' +
  '.bar{position:fixed;left:0;right:0;bottom:0;display:flex;gap:10px;background:var(--bg);' +
  'border-top:1px solid var(--line);padding:12px 16px calc(12px + env(safe-area-inset-bottom))}' +
  '.bar button{flex:1;padding:12px}.bar .go{background:var(--acc);border-color:var(--acc);color:var(--ink)}' +
  // The logbook.
  '.stats{display:flex;gap:10px;margin:0 0 16px}.stat{flex:1;background:var(--card);border-radius:14px;' +
  'padding:10px 12px}.stat b{display:block;font-size:28px;line-height:1.1}.stat span{color:var(--mute);' +
  'font-size:14px}' +
  '.from{display:flex;flex-wrap:wrap;gap:6px;margin:4px 0 0}.chip{border:1px solid var(--line);' +
  'border-radius:999px;padding:3px 10px;font-size:14px;color:var(--mute)}' +
  '.shelf h2{display:flex;justify-content:space-between;align-items:baseline}' +
  '.shelf h2 small{font-size:15px;font-weight:400;color:var(--mute)}' +
  '.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(74px,1fr));gap:8px;margin-top:10px}' +
  '.tile{display:flex;flex-direction:column;align-items:center;gap:4px;padding:8px 4px;font-weight:400;' +
  'font-size:13px;line-height:1.2;border:1px solid var(--line);border-radius:12px;background:none;' +
  'color:var(--fg);text-align:center;min-width:0}' +
  '.tile.no{color:var(--dim);border-style:dashed}.tile.sel{border-color:var(--acc);background:var(--sel)}' +
  '.pic{height:48px;width:100%;display:flex;align-items:center;justify-content:center}' +
  '.pic img{max-height:48px;max-width:64px;image-rendering:pixelated}' +
  '.no .pic img{filter:grayscale(1) brightness(.3)}' +
  // Stargazer: the pictures' brightness in red only (#ro), and stars in the page's red.
  '.red .pic img{filter:url(#ro)}.red .no .pic img{filter:url(#ro) brightness(.35)}' +
  '.red .pic span[style]{color:var(--fg)!important}' +
  '.pic .fig{width:64px;height:45px}.pic .ic{width:36px;height:36px}' +
  '.fig line,.fig polyline{stroke:currentColor;stroke-width:1.6;fill:none;stroke-linejoin:round}' +
  '.fig circle{fill:currentColor}' +
  '.ct{font-size:12px;color:var(--mute)}.nm{overflow-wrap:anywhere}' +
  '.info{background:var(--sel);border-radius:10px;padding:8px 12px;font-size:15px;margin:10px 0 0}' +
  '.recent{list-style:none;padding:0}.recent li{display:flex;gap:10px;align-items:center;color:var(--fg);' +
  'font-size:16px;padding:6px 0;border-top:1px solid var(--line);margin:0}.recent .ic{width:24px;height:24px;' +
  'flex:none;color:var(--mute)}.recent span span{display:block;color:var(--mute);font-size:14px}' +
  '[hidden]{display:none!important}' +
  '@media (prefers-reduced-motion:reduce){.sw input::after{transition:none}}';

// Save: everything on the page, back to index.js (webviewclosed); tabs;
// the undo buttons; a tile tapped shows its line under its shelf.
var SCRIPT =
  'var act={};' +
  'function on(i){var e=document.getElementById(i);return !!(e&&e.checked)}' +
  'function v(i){var e=document.getElementById(i);return e?e.value:null}' +
  'function save(){var c={sky:v("sky"),findShow:v("gear"),light:v("light"),' +
  'planes:{on:on("pl"),minFt:+v("minft"),maxKm:+v("maxkm"),source:v("src"),rx:(v("rx")||"").trim()},' +
  'units:v("units"),sats:{stations:on("st"),visual:on("vi"),trains:on("tr"),hidden:on("hi")},' +
  'forgetAim:!!act.fa,facts:on("fx"),reset:!!act.rs,' +
  'logbook:{where:on("lw"),clear:!!act.lc}};' +
  'location.href="pebblejs://close#"+encodeURIComponent(JSON.stringify(c))}' +
  'function tab(t){["set","book","about"].forEach(function(x){' +
  'document.getElementById("p-"+x).hidden=x!==t;document.getElementById("t-"+x).className=x===t?"on":""});' +
  'window.scrollTo(0,0)}' +
  'function arm(b){var k=b.getAttribute("data-k");if(b.className.indexOf("armed")>=0){act[k]=true;save();return}' +
  'b.className="danger armed";b.textContent="Tap again to confirm";' +
  'setTimeout(function(){b.className="danger";b.textContent=b.getAttribute("data-l")},4000)}' +
  'function tap(b){var s=b.parentNode.parentNode,i=s.querySelector(".info"),was=b.className.indexOf("sel")>=0;' +
  '[].forEach.call(s.querySelectorAll(".tile"),function(x){x.className=x.className.replace(" sel","")});' +
  'if(was){i.hidden=true;return}b.className+=" sel";i.textContent=b.getAttribute("data-n")+": "+' +
  'b.getAttribute("data-i");i.hidden=false}' +
  'function copyLog(b,id){var t=document.getElementById(id);t.select();' +
  't.setSelectionRange(0,t.value.length);document.execCommand("copy");b.textContent="Copied"}';

// ---------------------------------------------------------------- logbook

// A constellation's stick figure (collection.js figure: lines in a 0..100
// x 0..70 box), its stars as dots.
function figSvg(fig) {
  if (!fig) return ICONS.constellation;
  var dots = {};
  var lines = fig.map(function (pl) {
    pl.forEach(function (p) { dots[p[0] + ',' + p[1]] = p; });
    return '<polyline points="' + pl.map(function (p) { return p[0] + ',' + p[1]; }).join(' ') + '"/>';
  }).join('');
  return '<svg class="fig" viewBox="0 0 100 70" aria-hidden="true">' + lines +
         Object.keys(dots).map(function (k) {
           return '<circle cx="' + dots[k][0] + '" cy="' + dots[k][1] + '" r="2.6"/>';
         }).join('') + '</svg>';
}

function tilePic(shelf, t) {
  if (t.art && ART[t.art]) return '<img src="' + ART[t.art] + '" alt="">';
  if (shelf === 'cons') return figSvg(t.fig);
  if (shelf === 'stars') return '<span style="color:' + esc(t.color) + '">' + ICONS.star + '</span>';
  if (shelf === 'sats') return ICONS.satellite;
  if (shelf === 'planes') {
    return t.craft > 0 && CRAFT[t.craft]
      ? '<svg class="ic" viewBox="-64 -64 128 128" fill="currentColor" aria-hidden="true">' + CRAFT[t.craft] + '</svg>'
      : ICONS.plane;
  }
  return '';
}

// One shelf: its things, the ones not seen yet dimmed in their places.
function shelfHtml(sh) {
  if (!sh.tiles.length) return '';
  var count = sh.total ? sh.have + ' of ' + sh.total + (sh.extra ? ' + ' + sh.extra + ' more' : '') : String(sh.have);
  return '<section class="shelf"><h2>' + esc(sh.title) + ' <small>' + count + '</small></h2><div class="tiles">' +
    sh.tiles.map(function (t) {
      return '<button type="button" class="tile' + (t.seen ? '' : ' no') + '" data-n="' + esc(t.name) +
             '" data-i="' + esc(t.seen ? t.info : 'Not seen yet.') + '" onclick="tap(this)">' +
             '<span class="pic">' + tilePic(sh.id, t) + '</span><span class="nm">' + esc(t.name) + '</span>' +
             (t.n > 1 ? '<span class="ct">×' + t.n + '</span>' : '') + '</button>';
    }).join('') + '</div><p class="info" hidden></p></section>';
}

function bookTab(b) {
  var where = b.where || [];
  var head = '<div class="stats"><div class="stat"><b>' + b.things + '</b><span>' +
    (b.things === 1 ? 'thing' : 'things') + ' seen</span></div><div class="stat"><b>' + b.sightings +
    '</b><span>' + (b.sightings === 1 ? 'sighting' : 'sightings') + '</span></div></div>';
  var intro = b.sightings ? '' :
    '<section><h2>Start your collection</h2><p>Point at something: each answer the watch is sure of ' +
    '(THAT\'S IT or PROBABLY), and everything you find with Find it, goes in here.</p></section>';
  var from = where.length
    ? '<section><h2>Seen from</h2><div class="from">' + where.slice(0, 6).map(function (w) {
      return '<span class="chip">' + esc(w.label) + ' · ' + w.n + '</span>';
    }).join('') + (where.length > 6 ? '<span class="chip">+' + (where.length - 6) + ' more</span>' : '') +
      '</div></section>'
    : '';
  var recent = b.recent && b.recent.length
    ? '<section><h2>Latest</h2><ul class="recent">' + b.recent.map(function (r) {
      return '<li>' + (ICONS[r.kind] || ICONS.star) + '<span>' + esc(r.name) + '<span>' + esc(r.sub) +
             '</span></span></li>';
    }).join('') + '</ul></section>'
    : '';
  return head + intro + (b.shelves || []).map(shelfHtml).join('') + from + recent +
    '<section><h2>Where you saw them</h2>' +
    toggle('lw', 'Note roughly where', b.on,
           'To about 10 km, and kept only on this phone. Place names come from a list of towns on the ' +
           'phone, so where you were never leaves it. Turning this off forgets the places already noted.') +
    (b.sightings ? undo('lc', 'Clear the logbook', b.sightings + (b.sightings === 1 ? ' sighting' : ' sightings')) : '') +
    '</section>';
}

// ---------------------------------------------------------------- page

function setTab(s) {
  var metric = s.metric;
  var unitName = function (f) { return metric ? Math.round(f * 0.3048 / 50) * 50 + ' m' : f + ' ft'; };
  var distName = function (k) { return metric ? k + ' km' : Math.round(k / 1.609344) + ' mi'; };
  return '<section><h2>Your sky</h2>' +
    '<p class="note">City lights wash out faint stars. Pointer Planetarium only names what you can ' +
    'really see from where you are, and Find it lists what you can see with what you look with.</p>' +
    field('sky', 'Where you are', s.sky, [['city', 'City: about 80 stars'], ['suburbs', 'Suburbs: about 260 stars'],
                                          ['dark', 'Dark sky: about 900 stars']]) +
    field('gear', 'What you look with', s.show, [['eye', 'My eyes: the Moon, planets, bright stars'],
                                                 ['binoculars', 'Binoculars: fainter things too'],
                                                 ['all', 'Telescope: everything that\'s up']]) +
    '<p class="note">When you\'re somewhere new after dark, the watch asks again. With a dark sky, ' +
    'it turns red after sunset to keep your eyes used to the dark.</p>' +
    '<div class="safe">Never look at the Sun, with or without binoculars. Find it skips anything ' +
    'within ' + s.sunEye + ' degrees of it, or ' + s.sunAided + ' if it needs binoculars or a ' +
    'telescope.</div></section>' +

    '<section><h2>On the watch</h2>' +
    field('light', 'Keep the screen light on', s.light, [['read30', 'Finding, and reading for 30 s'],
                                                          ['read60', 'Finding, and reading for 1 min'],
                                                          ['finding', 'Only while finding'],
                                                          ['watch', 'The watch\'s own timing']]) +
    '<p class="note">Finding: until "Still looking?" or you lower the watch for 30 s. Reading: on an ' +
    'answer, the Find it list or how to find something, after your last press or touch. Only a light ' +
    'that\'s already on is kept on (never in daylight, or if you\'ve turned it off on the watch), and ' +
    'not at 20% battery or less.</p>' +
    row('units', 'Distances in', s.units, [['auto', 'Automatic'], ['imperial', 'Miles'], ['metric', 'Kilometers']]) +
    toggle('fx', 'A fun fact and a star chart after each answer', s.facts, '') +
    '</section>' +

    '<section><h2>Planes</h2>' +
    toggle('pl', 'Name the planes you point at', s.planes.on,
           'From live flight tracking. When you aim at PLANES or ANYTHING, your location, rounded to ' +
           'about 1 km, goes to the flight data service.') +
    row('maxkm', 'Look up to', s.planes.maxKm, s.maxKmChoices.map(function (k) { return [k, distName(k) + ' away']; })) +
    row('minft', 'Skip planes lower than', s.planes.minFt, s.minFtChoices.map(function (f) { return [f, unitName(f)]; })) +
    row('src', 'Flight data from', s.planes.source, [['auto', 'Automatic'], ['lol', 'adsb.lol'], ['fi', 'adsb.fi'],
                                                     ['rx', 'My own receiver']]) +
    '<details><summary>My own receiver</summary>' +
    '<p class="note">If you run an ADS-B receiver at home (tar1090 or readsb), put the address of its ' +
    'aircraft.json here. When it can\'t be reached, the public services are used.</p>' +
    '<input type="url" id="rx" placeholder="http://192.168.1.20/tar1090/data/aircraft.json" value="' +
    esc(s.planes.rx) + '"></details></section>' +

    '<section><h2>Satellites</h2>' +
    toggle('st', 'Space stations', s.sats.stations, s.satAgo.stations) +
    toggle('vi', 'Bright satellites', s.sats.visual, s.satAgo.visual) +
    toggle('tr', 'New Starlink trains', s.sats.trains,
           'A line of satellites, a few days after a launch. ' + s.satAgo.trains) +
    toggle('hi', "Include ones you can't see right now", s.sats.hidden,
           'In the Earth\'s shadow, or in daylight. SATELLITES only.') +
    '</section>' +

    '<section><h2>Your aim</h2>' +
    '<p>Everyone points a little differently. Pointer Planetarium learns how you point from the answers it ' +
    'is sure of (the Moon, planets and stars). To help it along when the Moon is up: on the ' +
    'watch, open Settings and choose <b>Tune on the Moon</b>.</p>' +
    '<ul>' + s.aimLines.join('') + '</ul>' +
    undo('fa', 'Start learning again', 'Both wrists') +
    '</section>' +

    '<section><h2>Start over</h2>' +
    undo('rs', 'Put every setting back', 'Downloaded data and the logbook are kept.') +
    '</section>';
}

function aboutTab(s) {
  return '<section><h2>Pointer Planetarium</h2>' +
    '<p>Point at the sky and your watch tells you what\'s there.</p>' +
    '<p>Sky, gear, theme, screen light, which wrist, and Tune on the Moon are also in the watch\'s ' +
    'Settings: the cog on the home screen, or hold SELECT. <b>Stargazer</b> turns the watch red, which ' +
    'keeps your eyes used to the dark.</p></section>' +

    '<section><h2>Copy the logbook</h2>' +
    '<p class="note">Everything in the logbook, as a spreadsheet (CSV).</p>' +
    '<textarea id="book" readonly>' + esc(s.logbook.csv || '') + '</textarea>' +
    '<p><button onclick="copyLog(this,\'book\')">Copy logbook</button></p></section>' +

    '<section><h2>Where the data comes from</h2><ul>' + s.credits.map(function (c) {
      return Array.isArray(c) ? '<li><a href="' + esc(c[1]) + '">' + esc(c[0]) + '</a></li>'
                              : '<li>' + esc(c) + '</li>';
    }).join('') + '</ul></section>';
}

function build(s) {
  return '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Pointer Planetarium</title><style>' + CSS + '</style><script>' + SCRIPT + '</script></head>' +
    '<body' + (s.red ? ' class="red"' : '') + '>' +
    (s.red ? '<svg width="0" height="0" style="position:absolute" aria-hidden="true"><filter id="ro">' +
             '<feColorMatrix type="matrix" values="0.3 0.59 0.11 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0"/>' +
             '</filter></svg>' : '') +
    '<header>' + ICONS.planet + '<h1>Pointer Planetarium</h1></header>' +
    (s.tonight ? '<div class="tonight">' + esc(s.tonight) + '</div>' : '') +
    '<nav class="tabs"><button type="button" id="t-set" class="on" onclick="tab(\'set\')">Settings</button>' +
    '<button type="button" id="t-book" onclick="tab(\'book\')">Logbook</button>' +
    '<button type="button" id="t-about" onclick="tab(\'about\')">About</button></nav>' +
    '<div id="p-set">' + setTab(s) + '</div>' +
    '<div id="p-book" hidden>' + bookTab(s.logbook) + '</div>' +
    '<div id="p-about" hidden>' + aboutTab(s) + '</div>' +
    '<div class="bar"><button onclick="location.href=\'pebblejs://close\'">Close</button>' +
    '<button class="go" onclick="save()">Save</button></div>' +
    '</body></html>';
}

module.exports = { build: build, esc: esc };
