// "Did you know?" facts for the answer cards: a few written ones for each
// well-known object, and some worked out from the answer itself: for a
// star, its colour and heat, its size, how much light it gives off, how
// our Sun would look from there and when its light left it (from the
// catalog's type, brightness and distance); for a planet, how far away it
// is now (and Venus's phase); for the Moon, how far it is, earthshine and
// the full Moon's name; for a plane, how fast and high it is and how far
// its trip is.
//
// Each subject's facts come round in turn (pickFact), the written ones
// first, the light-left-it fact last.
//
// Every fact fits the watch's fact card (FACT_MAX bytes). Text with a
// {imperial|metric} pair picks one by the units setting. The text is
// written for this app; the numbers are from NASA fact sheets, the IAU and
// the makers' own figures.

var A = require('./astro.js');
var stars = require('./stars.js');
var moonMod = require('./moon.js');
var planets = require('./planets.js');

var FACT_MAX = 120;
var LY_PER_PC = 3.26156;

// ---------------------------------------------------------------- written facts

var MOON = [
  'The same side of the Moon always faces the Earth.',
  '12 people have walked on the Moon, all between 1969 and 1972.',
  'Moonlight is sunlight bouncing off the gray rocks and dust of the Moon.',
  'The Moon drifts away from Earth by about {1.5 inches|4 cm} every year.',
  'Light from the Moon takes just over 1 second to reach your eyes.'
];

// Star patterns (patterns.js ids).
var PATTERNS = {
  bigdipper: [
    "The two stars at the end of the Big Dipper's bowl point to Polaris, the North Star.",
    "The Big Dipper isn't a constellation itself: it's the back and tail of Ursa Major, the Great Bear."
  ],
  littledipper: [
    "Polaris, the North Star, is the end of the Little Dipper's handle.",
    "Most of the Little Dipper's stars are faint: it takes a dark sky to see the whole thing."
  ],
  belt: [
    "Follow Orion's Belt one way to Sirius, the brightest star at night, and the other way to Aldebaran.",
    "The three stars of Orion's Belt are hundreds of light years apart. They only line up from here."
  ],
  orion: [
    "Betelgeuse, Orion's red shoulder, is a giant star near the end of its life.",
    "The fuzzy patch below Orion's Belt is the Orion Nebula, where new stars are forming."
  ],
  cassiopeia: [
    "From the northern half of the world, Cassiopeia's W sits across Polaris from the Big Dipper: one is always up.",
    "In Greek myth Cassiopeia was a queen, put in the sky on her throne."
  ],
  summer: [
    "Deneb looks the faintest of the Summer Triangle but it's by far the most powerful: it's just much farther away.",
    "The Milky Way runs right through the Summer Triangle, between Vega and Altair."
  ],
  winter: [
    "The Winter Triangle is three of the brightest stars in the sky: Betelgeuse, Procyon and Sirius.",
    'Sirius, the brightest corner of the Winter Triangle, is one of our nearest neighbors: 8.6 light years away.'
  ],
  pleiades: [
    "Most people see six or seven Pleiades by eye. Binoculars show dozens.",
    "The Pleiades formed about 100 million years ago, while dinosaurs walked the Earth."
  ],
  square: [
    "Few stars show inside the Great Square: count the ones you can see to judge how dark your sky is.",
    'Each side of the Great Square is about one and a half fists wide, held at arm\'s length.'
  ],
  cross: [
    "The Northern Cross is the brightest part of Cygnus, the Swan, flying down the Milky Way.",
    "Albireo, at the foot of the Northern Cross, is two stars, gold and blue, in a small telescope."
  ],
  scorpius: [
    "Antares, the red heart of Scorpius, is so big that it would swallow the orbit of Mars.",
    "Just past the scorpion's tail lies the centre of our galaxy, the Milky Way."
  ],
  teapot: [
    "The Teapot is part of Sagittarius. On a dark night the Milky Way rises from its spout like steam.",
    "Look toward the Teapot's spout and you're facing the centre of our galaxy."
  ],
  sickle: [
    "The Sickle is the Lion's head and mane: a backwards question mark ending in Regulus.",
    'The Leonid meteors of November seem to fly out of the Sickle.'
  ],
  hyades: [
    "The V is the Hyades, the nearest star cluster to us. Aldebaran just happens to sit in front of it.",
    'The stars of the Hyades were born together about 600 million years ago and still travel as a group.'
  ],
  crown: [
    "The Northern Crown is a small half circle of stars between Arcturus and Vega.",
    'The Northern Crown has a sleeping star, T Coronae Borealis, that flares up about every 80 years.'
  ],
  southerncross: [
    "The Southern Cross is the smallest of the 88 constellations.",
    "The long bar of the Southern Cross points toward the south pole of the sky."
  ]
};

var PLANETS = {
  mercury: [
    'Mercury is the smallest planet, and the closest to the Sun.',
    'A year on Mercury lasts just 88 Earth days.',
    'Mercury never strays far from the Sun, so you only see it low in the sky at dusk or dawn.',
    "Mercury has almost no air: its days are hot enough to melt lead, its nights colder than Antarctica's."
  ],
  venus: [
    'Venus is the hottest planet: hot enough to melt lead.',
    'Venus spins backwards. There, the Sun rises in the west.',
    'A day on Venus lasts longer than its whole year.'
  ],
  mars: [
    'Mars looks red because its dust is full of rust.',
    'Mars has the tallest volcano we know of, two and a half times as tall as Mount Everest.',
    'Rovers have been exploring Mars without a break since January 2004.'
  ],
  jupiter: [
    'More than 1,000 Earths could fit inside Jupiter.',
    "Jupiter's Great Red Spot is a storm bigger than the whole Earth.",
    'With binoculars you can see four of the moons of Jupiter as tiny dots beside it.'
  ],
  saturn: [
    "Saturn's rings are made of chunks of ice and rock, some as big as a house.",
    'Saturn is so light for its size that it would float in a giant bathtub.',
    'With a small telescope you can see the rings of Saturn.'
  ],
  uranus: [
    'Uranus spins on its side, like a ball rolling around the Sun.',
    'Uranus was the first planet found with a telescope, in 1781.',
    'A year on Uranus lasts 84 Earth years.',
    'From a very dark place, Uranus is just bright enough to see by eye, if you know exactly where to look.'
  ],
  neptune: [
    'Neptune has the fastest winds of any planet.',
    'Neptune was found by math: astronomers worked out where it had to be before anyone saw it.',
    'Neptune takes 165 years to go around the Sun. It finished its first lap since its discovery in 2011.'
  ]
};

// By NORAD catalog number.
var SATS = {
  25544: [
    'The Space Station goes around the Earth about every 90 minutes: 16 sunrises a day.',
    'The Space Station flies {almost 5 miles|about 7.7 km} every second.',
    'People have lived on the Space Station without a break since November 2000.'
  ],
  48274: [
    "Tiangong is China's space station. Its name means \"Heavenly Palace\".",
    'Tiangong goes around the Earth about every 90 minutes.'
  ],
  20580: [
    'Hubble has been taking pictures of space since 1990.',
    'The Hubble telescope is about as long as a school bus.'
  ]
};

var STARLINK = [
  'Starlink satellites beam internet down to the ground.',
  'Just after launch, Starlink satellites fly in a line like a string of pearls, then spread out.'
];
var SATELLITE = [
  'You can see a satellite because sunlight shines on it, high above, even after dark down here.',
  'A satellite glides along steadily. A plane has blinking lights.'
];
var ROCKET = ['Used rocket stages can circle the Earth for years before they fall back and burn up.'];

// By IAU name. Distances are left to the catalog (see lightFact).
var STARS = {
  Sirius: ['Sirius is the brightest star in the night sky.',
           'Sirius has a tiny partner star, a white dwarf about the size of the Earth.'],
  Canopus: ['Canopus is the second brightest star. Spacecraft use it to find their way.'],
  Arcturus: ['"Arc to Arcturus": follow the curve of the Big Dipper\'s handle to find it.',
             'Light from Arcturus switched on the lights of the 1933 World\'s Fair in Chicago.'],
  Vega: ['Vega was the North Star 14,000 years ago, and will be again in about 12,000 years.',
         'Vega was the first star ever photographed, apart from the Sun, in 1850.'],
  Capella: ['Capella looks like one star, but it is really four: two pairs.'],
  Rigel: ["Rigel is Orion's bright blue foot, tens of thousands of times brighter than the Sun."],
  Procyon: ['Procyon means "before the dog": it rises just before Sirius, the Dog Star.'],
  Achernar: ['Achernar spins so fast it is squashed: much wider around its middle.'],
  Betelgeuse: ['Put Betelgeuse where the Sun is and it would swallow Mercury, Venus, Earth and Mars.',
               'Betelgeuse will explode as a supernova one day, maybe in the next 100,000 years.'],
  Altair: ['Altair spins around in less than 10 hours. The Sun takes almost a month.',
           'Altair, Vega and Deneb make the Summer Triangle.'],
  Aldebaran: ['Aldebaran is the red eye of Taurus the Bull.',
              'The Pioneer 10 spacecraft is heading toward Aldebaran. It will take about 2 million years.'],
  Antares: ['Antares means "rival of Mars", because it is red like Mars.',
            'Antares is the red heart of Scorpius the Scorpion.'],
  Spica: ['Spica is two stars so close together that they pull each other into egg shapes.'],
  Pollux: ['Pollux has a giant planet going around it.',
           'Pollux and Castor are the heads of Gemini, the Twins.'],
  Castor: ['Castor looks like one star but is six: three pairs going around each other.'],
  Fomalhaut: ['Fomalhaut is called the lonely star of autumn: no other bright star is near it.',
              'Fomalhaut has a huge ring of dust around it, like a giant version of our asteroid belt.'],
  Deneb: ['Deneb is one of the most powerful stars you can see: tens of thousands of times brighter than the Sun.',
          'Deneb is the tail of Cygnus the Swan, and the top of the Northern Cross.'],
  Regulus: ['Regulus spins so fast that it bulges out around its middle.',
            'Regulus is the heart of Leo the Lion.'],
  Polaris: ["Polaris, the North Star, stays put while every other star circles around it.",
            'Polaris is not one of the very brightest stars, but sailors have steered by it for centuries.'],
  Mizar: ['People used Mizar and its faint neighbor Alcor as an eyesight test. Can you see both?'],
  Dubhe: ['Dubhe and Merak are the Pointers: a line through them leads to the North Star.'],
  Merak: ['Merak and Dubhe are the Pointers: a line through them leads to the North Star.'],
  Megrez: ["Megrez is the faintest of the Big Dipper's seven stars."],
  Alkaid: ['Alkaid is the star at the very end of the Big Dipper\'s handle.'],
  Bellatrix: ["Bellatrix means \"female warrior\". It is Orion's left shoulder."],
  Mintaka: ['Mintaka, in Orion\'s Belt, rises almost exactly in the east and sets in the west, wherever you are.'],
  Alnilam: ["Alnilam is the middle star of Orion's Belt."],
  Alnitak: ["Alnitak is the eastern star of Orion's Belt. The Horsehead Nebula is just below it."],
  Saiph: ["Saiph is Orion's right knee."],
  Algol: ['Algol, the Demon Star, dims every 2 days and 21 hours, when its partner star passes in front.'],
  Mira: ['Mira, "the wonderful", fades from easy to see to invisible and back about every 11 months.'],
  Denebola: ['Denebola means "the lion\'s tail".'],
  Shaula: ["Shaula is the stinger in the Scorpion's tail."],
  'Kaus Australis': ['Kaus Australis is the bottom of the Teapot in Sagittarius.'],
  Alphard: ['Alphard means "the lonely one": it sits alone in a dim part of the sky.'],
  Alpheratz: ['Alpheratz is a corner of the Great Square of Pegasus, but it belongs to Andromeda.'],
  Markab: ['Markab is a corner of the Great Square of Pegasus.'],
  Enif: ["Enif is the nose of Pegasus, the flying horse."],
  Thuban: ['Thuban was the North Star when the Egyptian pyramids were built.'],
  Albireo: ['Albireo is two stars, one gold and one blue. A small telescope shows both.'],
  Sadr: ['Sadr is the middle of the Northern Cross, in Cygnus the Swan.'],
  Alphecca: ['Alphecca is the jewel in the Northern Crown.'],
  Zubenelgenubi: ['Zubenelgenubi means "the southern claw": Libra used to be the claws of the Scorpion.'],
  Zubeneschamali: ['Zubeneschamali means "the northern claw": Libra used to be the claws of the Scorpion.'],
  Ankaa: ['Ankaa is the brightest star in Phoenix, the firebird.'],
  Hamal: ['Hamal is the head of Aries the Ram.'],
  Mirfak: ['Mirfak sits in a loose cluster of stars that looks lovely in binoculars.'],
  Schedar: ["Schedar is one of the five stars of Cassiopeia's W."],
  Caph: ["Caph is one end of Cassiopeia's W."],
  Rasalhague: ['Rasalhague is the head of Ophiuchus, the Serpent Bearer.'],
  Eltanin: ['Eltanin is the eye of Draco the Dragon.'],
  Diphda: ['Diphda is the tail of Cetus, the sea monster.'],
  Acrux: ['Acrux is the bottom of the Southern Cross.'],
  Hadar: ['Hadar and Rigil Kentaurus point the way to the Southern Cross.'],
  'Rigil Kentaurus': ['Rigil Kentaurus is the nearest star you can see by eye: its light takes about 4.4 years to get here.',
                      'Rigil Kentaurus and Toliman go around each other every 80 years, with tiny Proxima Centauri far out.'],
  // The bright ones (to magnitude 2.5) that had nothing written.
  Mirach: ['From Mirach, hop up two fainter stars toward Cassiopeia to find the Andromeda Galaxy, a faint smudge.'],
  Almach: ['Almach is a lovely double star: a small telescope shows a golden star with a blue one beside it.'],
  Elnath: ["Elnath is the tip of one of Taurus the Bull's horns. It used to be counted in Auriga, too."],
  Menkalinan: ['Menkalinan is two stars that pass in front of each other every 4 days, dimming it a little.'],
  Mirzam: ['Mirzam means "the herald": it rises just before Sirius, as if announcing it.'],
  Alhena: ['Alhena is the foot of Pollux, one of the Gemini twins.'],
  Adhara: ['Nearly 5 million years ago Adhara passed close to us and was far brighter than Sirius is now.'],
  Wezen: ['Wezen means "the weight". It is a supergiant, tens of thousands of times as bright as the Sun.'],
  Aludra: ['Aludra is the tip of the tail of Canis Major, the Big Dog.'],
  Naos: ['Naos is one of the hottest stars you can see by eye: about {72,000 degrees F|40,000 degrees C} at its surface.'],
  Avior: ['Avior is the brightest star of the False Cross, which people often mistake for the Southern Cross.'],
  Alsephina: ['Alsephina is part of the False Cross. Two of its stars pass in front of each other every 45 days.'],
  Suhail: ['Suhail is an orange supergiant in Vela, the sails of the Argo, the ship of Jason and his heroes.'],
  Miaplacidus: ['Miaplacidus is a bright star of the far south: from the mainland USA it never rises.'],
  Aspidiske: ['Aspidiske means "little shield" in Greek. It is part of the False Cross.'],
  Phecda: ['Phecda and most of the Big Dipper travel through space together, as a family of stars born together.'],
  Gacrux: ['Gacrux, the top of the Southern Cross, is a red giant: it looks orange next to its blue-white neighbors.'],
  Mimosa: ['Mimosa is one of the Southern Cross stars on the flags of Australia, New Zealand and Brazil.'],
  Alioth: ["Alioth is the brightest star of the Big Dipper, the first star of its handle."],
  Menkent: ['Menkent is the shoulder of Centaurus, the centaur.'],
  Toliman: ['Toliman is the smaller partner of Rigil Kentaurus. The two go around each other every 80 years.'],
  Kochab: ['Kochab and Pherkad are the Guardians of the Pole: they circle Polaris all night.',
           'About 3,000 years ago Kochab was nearer the north pole of the sky than Polaris.'],
  Dschubba: ['Dschubba is the forehead of the Scorpion. In 2000 it suddenly got brighter, and it has changed ever since.'],
  Atria: ["Atria's name is short for Alpha Trianguli Australis: it is the brightest star of the Southern Triangle."],
  Larawag: ['Larawag is a name from the Wardaman people of northern Australia, adopted by the IAU in 2017.'],
  Sabik: ['Sabik is two similar stars that go around each other every 88 years.'],
  Sargas: ['Sargas is one of the oldest star names still in use: it comes from ancient Sumer.'],
  Nunki: ["Nunki is the top of the Teapot's handle in Sagittarius. Its name comes from ancient Babylon."],
  Peacock: ['Peacock got its name in the 1930s, for a navigation almanac, after its constellation Pavo.'],
  Aljanah: ['Aljanah means "the wing": it is on one wing of Cygnus, the Swan.'],
  Alderamin: ["Alderamin will be the North Star in about 5,500 years, as the Earth's axis slowly wobbles."],
  Alnair: ['Alnair means "the bright one". It is the brightest star in Grus, the Crane.'],
  Tiaki: ['Tiaki is a red giant in Grus, the Crane, that slowly changes in brightness.'],
  Scheat: ['Scheat is a red giant at a corner of the Great Square, about 100 times as wide as the Sun.']
};

// By IAU abbreviation: one or more facts each.
var CONSTELLATIONS = {
  And: ['The Andromeda Galaxy, 2.5 million light years away, is the farthest thing most people can see with just their eyes.',
        'In Greek myth Andromeda was chained to a rock as a meal for a sea monster, and saved by Perseus.'],
  Ant: ['Antlia is an air pump: it was named in the 1750s after the newest science tools.'],
  Aps: ['Apus, the bird of paradise, is so far south that it never rises anywhere in the mainland USA.'],
  Aql: ['Aquila is an eagle. Its bright star Altair is part of the Summer Triangle.',
        'In Greek myth Aquila was the eagle that carried Zeus\'s thunderbolts.'],
  Aqr: ['Aquarius, the water carrier, pours a stream of faint stars down toward the bright star Fomalhaut.'],
  Ara: ['Ara is the altar where, in Greek myth, the gods swore an oath before their war with the Titans.'],
  Ari: ['Aries the Ram is where the Sun crossed the sky\'s equator in spring 2,000 years ago. That spot has drifted into Pisces.'],
  Aur: ['Auriga is a charioteer, holding a goat and her kids.',
        'Auriga holds Capella, which is farther north in the sky than any other star as bright.'],
  Boo: ['Bootes is a herdsman. Its stars make the shape of a kite.',
        'Beyond Bootes lies a huge empty region of space, the Bootes Void, with very few galaxies in it.'],
  Cae: ['Caelum, the chisel, is one of the faintest constellations: even its brightest star needs a dark sky.'],
  Cam: ['Camelopardalis is a giraffe. Its stars are all faint.'],
  Cnc: ['Cancer the Crab holds the Beehive, a cluster of stars that looks like a fuzzy patch.'],
  CVn: ['Canes Venatici are the hunting dogs of Bootes.'],
  CMa: ['Canis Major is the big dog. It has Sirius, the brightest star of all.',
        'Canis Major is the big hunting dog of Orion, following him across the sky.'],
  CMi: ['Canis Minor, the little dog, is mostly just two stars: bright Procyon and fainter Gomeisa.'],
  Cap: ['Capricornus is a sea goat: half goat, half fish.'],
  Car: ['Carina was the keel of the Argo, the ship of Jason and his heroes.'],
  Cas: ['Cassiopeia is a queen on her throne. Her stars make a big W.',
        'In 1572 a new star blazed up in Cassiopeia, bright enough to see by day: an exploding star.'],
  Cen: ['Centaurus has Alpha Centauri, the nearest star system to us.',
        'Centaurus holds Omega Centauri, the biggest ball of stars around our galaxy: millions of them.'],
  Cep: ['Cepheus is a king, the husband of Cassiopeia.',
        'Cepheus holds Delta Cephei, the kind of star astronomers use to measure distances to other galaxies.'],
  Cet: ['Cetus, the sea monster, holds Mira, a star that fades out of sight and comes back every 11 months.'],
  Cha: ['Chamaeleon is a small, faint chameleon close to the south pole of the sky.'],
  Cir: ['Circinus is a pair of compasses for drawing circles.'],
  Col: ['Columba is the dove that Noah sent out from the ark. It perches below Orion.'],
  Com: ['Coma Berenices is the hair of Queen Berenice.'],
  CrA: ['Corona Australis, the southern crown, is a little arc of stars just below the Teapot of Sagittarius.'],
  CrB: ['Corona Borealis, the northern crown, is a little half-circle of stars.'],
  Crv: ['Corvus, the crow, is a neat little four-sided shape of stars, easy to pick out in spring.'],
  Crt: ['Crater is a cup. In Greek myth, Corvus the crow was sent to fetch water in it, and dawdled.'],
  Cru: ['The Southern Cross is the smallest of all 88 constellations.',
        'The Southern Cross is on the flags of Australia, New Zealand, Brazil, Samoa and Papua New Guinea.'],
  Cyg: ['Cygnus is a swan flying along the Milky Way. Its brightest stars make the Northern Cross.',
        'Cygnus holds Cygnus X-1, one of the first black holes ever found.'],
  Del: ['Delphinus is a little dolphin jumping out of the Milky Way.'],
  Dor: ['Dorado is a fish. It holds most of the Large Magellanic Cloud, a small galaxy next to ours.'],
  Dra: ['Draco is a dragon that winds between the Big and Little Dippers.',
        'The Draconid meteors in October seem to come from Draco, the dragon.'],
  Equ: ['Equuleus, the little horse, is the second smallest constellation.'],
  Eri: ['Eridanus is a river, one of the longest constellations in the sky.'],
  For: ['Fornax, the furnace, holds the Hubble Ultra Deep Field: thousands of galaxies in one dark speck of sky.'],
  Gem: ['Gemini are the twins, Castor and Pollux. The Geminid meteors in December seem to fly out of them.',
        'Castor, one of the Gemini twins, looks like one star but is really six.'],
  Gru: ['Grus, the crane, was named about 400 years ago from the notes of Dutch sailors exploring the southern seas.'],
  Her: ['Hercules holds a ball of hundreds of thousands of stars, the Great Cluster.',
        'Hercules is upside down in the sky: his head points south, and his feet point toward the North Star.'],
  Hor: ['Horologium is a pendulum clock, named in the 1750s for what was then the most accurate clock there was.'],
  Hya: ['Hydra the water snake is the biggest constellation of all: over a quarter of the way across the sky.'],
  Hyi: ['Hydrus, the little water snake, winds between the two Magellanic Clouds, small galaxies next to ours.'],
  Ind: ['Indus was named in the 1590s by Dutch navigators. It shows one of the people they met on their voyages.'],
  Lac: ['Lacerta, the lizard, is a zigzag of faint stars squeezed between Cygnus and Andromeda.'],
  Leo: ['Leo is a lion. The Leonid meteors in November seem to come from it.',
        'Leo is one of the few constellations that looks like what it is named for: a crouching lion.'],
  LMi: ['Leo Minor, the little lion, has no star called Alpha: the astronomer who lettered its stars skipped it.'],
  Lep: ['Lepus is a hare, hiding under the feet of Orion the Hunter.'],
  Lib: ['Libra, the scales, is the only zodiac sign that is not a living thing.'],
  Lup: ['Lupus, the wolf, is where the brightest supernova ever recorded blazed up, in the year 1006.'],
  Lyn: ['Lynx is so faint that you need the eyes of a lynx to see it.'],
  Lyr: ['Lyra is the harp of Orpheus. Its star Vega is one of the brightest.',
        'The Lyrid meteors in April seem to come from Lyra. People have recorded them for over 2,600 years.'],
  Men: ['Mensa is Table Mountain in South Africa: the only constellation named after a place.'],
  Mic: ['Microscopium is a microscope, one of the science tools Lacaille put in the southern sky in the 1750s.'],
  Mon: ['Monoceros, the unicorn, is faint, but the Milky Way runs through it, full of star clusters.'],
  Mus: ['Musca, the fly, buzzes just below the Southern Cross.'],
  Nor: ['Norma, the carpenter\'s square, lies across a bright stretch of the southern Milky Way.'],
  Oct: ['Octans holds the south pole of the sky, and no bright star marks it: the south has no Pole Star.'],
  Oph: ['Ophiuchus holds a snake. The Sun passes through it, but it is not one of the zodiac signs.'],
  Ori: ['Orion the Hunter has a star nursery in his sword: the Orion Nebula, a fuzzy patch.',
        'Orion sits on the sky\'s equator, so it can be seen from everywhere on Earth.'],
  Pav: ['Pavo, the peacock, holds a bright star that is simply named Peacock.'],
  Peg: ['Pegasus is a flying horse. Four of its stars make the Great Square.',
        'The first planet found around a Sun-like star, in 1995, goes around 51 Pegasi, a faint star in Pegasus.'],
  Per: ['Perseus is a hero. The Perseid meteors in August seem to come from him.',
        'Perseus holds Algol, the Demon Star, which dims every few days as a partner star passes in front.'],
  Phe: ['Phoenix is a firebird that is born again from its own ashes.'],
  Pic: ['Pictor, the painter\'s easel, holds Beta Pictoris, a young star with planets still forming around it.'],
  Psc: ['Pisces are two fish tied together by their tails.',
        'Pisces holds the spot where the Sun crosses the sky\'s equator every March, at the start of spring.'],
  PsA: ['Piscis Austrinus is the southern fish. Fomalhaut is its mouth.'],
  Pup: ['Puppis was the back of the Argo, the ship of Jason and his heroes.'],
  Pyx: ['Pyxis, the ship\'s compass, was added in the 1750s beside the old ship Argo.'],
  Ret: ['Reticulum is the crosshairs of an eyepiece, like the one Lacaille used to map the southern stars.'],
  Sge: ['Sagitta, the arrow, is the third smallest constellation.'],
  Sgr: ['Sagittarius looks like a teapot. The center of our galaxy is in its direction.',
        'Sagittarius holds more star clusters and nebulas from Messier\'s famous list than any other constellation.'],
  Sco: ['Scorpius stung Orion, so the two are never in the sky at the same time.',
        'Scorpius is one of the few constellations that really looks like its name: a curling scorpion.'],
  Scl: ['Sculptor holds the south pole of our galaxy: look there and you look straight out of the Milky Way.'],
  Sct: ['Scutum, the shield, sits in one of the brightest patches of the Milky Way, the Scutum Star Cloud.'],
  Ser: ['Serpens is a snake, and the only constellation in two separate parts.'],
  Sex: ['Sextans is a sextant, a tool sailors used to measure the stars.'],
  Tau: ['Taurus the Bull has two star clusters: the Pleiades and the Hyades.',
        'The Crab Nebula, in Taurus, is what is left of a star that exploded in 1054. Chinese astronomers saw it.'],
  Tel: ['Telescopium is a telescope, named in the 1750s. Its stars are faint: you almost need one to see it.'],
  Tri: ['Triangulum has a galaxy you can just see from very dark places.'],
  TrA: ['Triangulum Australe is the southern triangle.'],
  Tuc: ['Tucana is a toucan, near the Small Magellanic Cloud, a little galaxy next to ours.'],
  UMa: ['Ursa Major is the Great Bear. The Big Dipper is its back and tail.',
        'From the northern USA, the Big Dipper never sets: it circles the North Star all night, all year.'],
  UMi: ['Ursa Minor is the Little Bear, or Little Dipper. The North Star is the end of its handle.',
        'Polaris, at the end of the Little Bear\'s tail, is less than a degree from the north pole of the sky.'],
  Vel: ['Vela was the sails of the Argo, the ship of Jason and his heroes.'],
  Vir: ['Virgo is the biggest of the zodiac constellations.',
        'Toward Virgo lies a crowd of more than a thousand galaxies, the Virgo Cluster.'],
  Vol: ['Volans, the flying fish, leaps beside Carina, the keel of the old ship Argo.'],
  Vul: ['Vulpecula, the little fox, holds the Dumbbell Nebula, the glowing gas thrown off by a dying star.']
};

// Plane families by ICAO type code: [code list, seats ("" when it varies a
// lot), facts]. Seats are typical for a US airline layout.
var PLANE_FAMILIES = [
  [['A318', 'A319', 'A19N'], 'about 120 to 150', ['The Airbus A319 is the short version of the A320.']],
  [['A320', 'A20N'], 'about 150 to 180',
   ['More than 10,000 planes of the Airbus A320 family have been built.',
    'Airbus builds A320s in France, Germany, China and the USA.']],
  [['A321', 'A21N'], 'about 190 to 220',
   ['The A321 is the longest plane in the Airbus A320 family.']],
  [['B737', 'B738', 'B739', 'B37M', 'B38M', 'B39M', 'B3XM'], 'about 140 to 200',
   ['The Boeing 737 first flew in 1967 and is still being built.',
    'More than 11,000 Boeing 737s have been built.']],
  [['B712'], 'about 110', ['The Boeing 717 was the last airliner McDonnell Douglas designed.']],
  [['B752', 'B753'], 'about 180 to 230',
   ['The 757 has big engines for its size, so it can climb steeply and use short runways.']],
  [['B762', 'B763', 'B764'], 'about 200 to 260',
   ['Many 767s now carry packages for FedEx, UPS and Amazon.']],
  [['B772', 'B77L', 'B77W', 'B778', 'B779'], 'about 300 to 400',
   ["A grown-up could stand up inside the front of a 777's engine."]],
  [['B788', 'B789', 'B78X'], 'about 240 to 330',
   ['Half of a 787 (by weight) is carbon fiber, like a racing bike.',
    'The 787 has no window shades: the windows darken at the press of a button.']],
  [['B744', 'B748'], '',
   ['The 747, the Queen of the Skies, first flew in 1969. Its hump is an upstairs deck.']],
  [['A332', 'A333', 'A338', 'A339'], 'about 250 to 300',
   ['The Airbus A330 can fly more than {6,000 miles|10,000 km} without stopping.']],
  [['A359', 'A35K'], 'about 300 to 350', ['More than half of an Airbus A350 is made of carbon fiber.']],
  [['A388'], 'about 500 or more', ['The Airbus A380 is the biggest airliner ever: two full decks of seats.']],
  [['BCS1', 'BCS3'], 'about 100 to 140',
   ['The Airbus A220 was designed in Canada, as the Bombardier CSeries.']],
  [['E170', 'E75L', 'E75S', 'E190', 'E195', 'E290', 'E295'], 'about 70 to 120',
   ['Embraer jets are built in Brazil.']],
  [['CRJ2', 'CRJ7', 'CRJ9', 'CRJX'], 'about 50 to 90', ['CRJ jets were designed in Canada for short trips.']],
  [['DH8D'], 'about 70 to 80', ['The Dash 8-400 has propellers, driven by jet engines called turboprops.']],
  [['AT72', 'AT76'], 'about 70', ['ATR planes are built in France and Italy. Their propellers are turned by turbines.']],
  [['MD11'], '', ['The MD-11 has three engines: one is up in its tail.']],
  [['C172'], '4', ['The Cessna 172 is the most-built airplane ever: more than 44,000 of them.']],
  [['C152'], '2', ['The Cessna 152 is a little two-seater that many pilots learn to fly in.']],
  [['C182'], '4', ['The Cessna 182 is a four-seater, a bit bigger and faster than the 172.']],
  [['C208'], '', ['Cessna Caravans carry packages, passengers and skydivers, with one propeller.']],
  [['P28A', 'PA28'], '4', ['The Piper Cherokee is a four-seater that many pilots learn to fly in.']],
  [['SR20', 'SR22'], '4 or 5', ['Cirrus planes carry a parachute for the whole airplane!']],
  [['R22', 'R44', 'R66'], '', ['Robinson helicopters are some of the most popular small helicopters in the world.']],
  [['PC12'], '', ['The Pilatus PC-12 is built in Switzerland and has one big propeller.']],
  [['BE35', 'BE36'], '4 to 6', ['The Beechcraft Bonanza has been built since 1947, longer than any other airplane.']],
  [['BE20', 'BE30', 'BE9L', 'B350'], '', ['Beechcraft King Airs have been built since 1964.']],
  [['GLF6', 'GA6C'], '', ['The Gulfstream G650 is a business jet that can fly at nearly the speed of sound.']],
  [['AS50', 'EC30'], '', ['A helicopter like this one, an H125, once landed on top of Mount Everest.']],
  [['EC35', 'EC45'], '', ['Helicopters like this one often fly patients to hospitals.']],
  [['F16'], '1', ['The F-16 Fighting Falcon can turn so hard the pilot feels 9 times heavier.']],
  [['F35'], '1', ["An F-35 pilot's helmet shows camera views, so they can see through the floor of the plane."]],
  [['C130', 'C30J'], '', ['The C-130 Hercules can land on dirt and grass runways.']],
  [['K35R', 'KC46'], '', ['This plane is a flying gas station: it refuels other planes in midair.']],
  // Freighters, business jets, trainers and warbirds, common around
  // airports and air bases too.
  [['A306', 'A30B', 'A310'], '',
   ['The Airbus A300 was the first wide-body airliner with just two engines. Many now carry packages.']],
  [['E135', 'E145', 'E45X'], 'about 37 to 50', ['The Embraer ERJ 145 is a small airliner with its two engines at the back.']],
  [['C25A', 'C25B', 'C25C', 'C525', 'C550', 'C560', 'C56X', 'C680', 'C68A', 'C700', 'C750'], '',
   ['Cessna has built thousands of Citation business jets since the first one was delivered in 1972.']],
  [['E50P', 'E55P'], '', ['The Embraer Phenom 300 has been the best-selling light business jet for years.']],
  [['HDJT'], '', ['The HondaJet has its engines on top of its wings, which frees up room inside.']],
  [['CL30', 'CL35', 'CL60'], '', ['Bombardier Challenger business jets are built in Canada.']],
  [['GLEX', 'GL5T', 'GL6T', 'GL7T'], '', ['Bombardier Global jets can fly business travelers across oceans without stopping.']],
  [['GLF4', 'GLF5', 'GA5C', 'G280'], '', ['Gulfstream business jets are built in Savannah, Georgia.']],
  [['LJ35', 'LJ45', 'LJ60', 'LJ75'], '', ['The first Learjet flew in 1963 and made the small business jet famous.']],
  [['PC24'], '', ['The Pilatus PC-24 is a business jet built to land on short and even unpaved runways.']],
  [['BE55', 'BE58'], '4 to 6', ['The Beechcraft Baron is a small twin-engine plane, built since 1961.']],
  [['DA20', 'DV20', 'DA40', 'DA42', 'DA62'], '',
   ['Diamond planes are built mostly of composites, like a glider. Many flight schools use them.']],
  [['PA44'], '4', ['The Piper Seminole is a light twin that many pilots train in to learn to fly with two engines.']],
  [['PA34'], '6', ['The Piper Seneca is a six-seat twin, built since 1971.']],
  [['PA32', 'P32R'], '6', ['The Piper Saratoga and Cherokee Six carry six people on one engine.']],
  [['PA46', 'P46T'], '6', ['The Piper Malibu has a pressurized cabin, so it can fly above much of the weather.']],
  [['M20J', 'M20K', 'M20P', 'M20R', 'M20T'], '4',
   ['Mooney planes are known for being fast for their size. Their tails look swept forward.']],
  [['C206', 'C207', 'T206', 'C210'], '6', ['A Cessna 206 can carry six people, or wear floats and land on water.']],
  [['AT3T', 'AT5T', 'AT6T', 'AT8T'], '1', ['Air Tractors spray crops, and some scoop up or carry water to drop on wildfires.']],
  [['B06', 'B407', 'B429', 'B505', 'B212', 'B412'], '',
   ['Bell helicopters are built in Texas and Canada. The Bell JetRanger was a favorite of TV news crews.']],
  [['H60'], '', ['The Black Hawk helicopter has been flying with the US Army since 1979.']],
  [['H47'], '', ['The Chinook helicopter has two big rotors turning opposite ways, so it needs no tail rotor.']],
  [['V22'], '', ['The V-22 Osprey takes off like a helicopter, then tilts its rotors forward to fly like a plane.']],
  [['C17'], '', ['The C-17 Globemaster can carry a tank and land on short, rough runways.']],
  [['C5M'], '', ['The C-5 Galaxy is one of the biggest military planes: its whole nose lifts up to load cargo.']],
  [['E3TF', 'E3CF'], '', ['The dish on top of an E-3 Sentry is a radar that can watch planes hundreds of miles away.']],
  [['P8'], '', ['The P-8 Poseidon is a Boeing 737 turned into a submarine hunter for the Navy.']],
  [['F15'], '', ['The F-15 Eagle has won more than 100 air battles without losing one.']],
  [['F18', 'F18S'], '', ['The F/A-18 Hornet lands on aircraft carriers, caught by a hook and a wire.']],
  [['F22'], '1', ['The F-22 Raptor can fly faster than sound without using its afterburners.']],
  [['A10'], '1', ['The A-10 Warthog is built around a huge gun, and it is tough enough to fly home full of holes.']],
  [['B52'], '', ['The B-52 first flew in 1952, and the Air Force plans to fly it into the 2050s.']],
  [['B1'], '', ['The B-1 Lancer swings its wings forward to fly slowly and back to fly fast.']],
  [['U2'], '1', ['The U-2 spy plane flies so high, about {70,000 ft|21 km}, that its pilots wear pressure suits.']],
  [['T38'], '2', ['The T-38 Talon trains fighter pilots, and NASA astronauts fly it to keep their skills sharp.']],
  [['TEX2'], '2', ['The T-6 Texan II is the first plane many US military pilots learn to fly.']],
  [['B17'], '', ['Only a handful of the 12,731 B-17 Flying Fortresses built during World War II can still fly.']],
  [['B25'], '', ['B-25 Mitchell bombers took off from an aircraft carrier for the Doolittle Raid in 1942.']],
  [['P51'], '1', ['The P-51 Mustang could escort bombers all the way to Germany and back in World War II.']],
  [['DC3'], '', ['The DC-3 first flew in 1935, and a few still carry cargo and passengers today.']]
];

var PLANE_BY_CODE = {};
PLANE_FAMILIES.forEach(function (f) {
  f[0].forEach(function (code) { PLANE_BY_CODE[code] = { seats: f[1], facts: f[2] }; });
});

// ---------------------------------------------------------------- worked-out facts

function commas(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function minutesText(min) {
  min = Math.round(min);
  if (min < 60) return min + (min === 1 ? ' minute' : ' minutes');
  var h = Math.floor(min / 60), m = min % 60;
  return h + (h === 1 ? ' hour' : ' hours') + (m ? ' ' + m + (m === 1 ? ' minute' : ' minutes') : '');
}

// Light from a planet distAU away.
function planetLight(name, distAU) {
  if (!(distAU > 0)) return null;
  return 'Light from ' + name + ' takes ' + minutesText(distAU * 8.3167) + ' to reach your eyes.';
}

// Light from a star ly light years away: the year it left, or how long ago.
function starLight(name, ly, year) {
  if (!(ly > 0)) return null;
  if (ly < 1000) {
    return 'The light you see from ' + name + ' left it in ' + (year - Math.round(ly)) +
           ': you see it as it was then.';
  }
  return 'The light you see from ' + name + ' left it about ' + commas(Math.round(ly / 100) * 100) +
         ' years ago.';
}

// About as many as that, said plainly: 2.5, 48, 630, 3,200.
function about(x) {
  if (x < 10) return String(Math.round(x * 10) / 10);
  var p = Math.pow(10, Math.floor(Math.log10(x)) - 1);
  return commas(Math.round(x / p) * p);
}

// Star colour and surface heat by class (typical for each), and the words.
var STAR_CLASS = {
  O: 'a blue star, among the hottest there are: about {63,000 degrees F|35,000 degrees C} at its surface.',
  B: 'a blue-white star, far hotter than the Sun: about {27,000 degrees F|15,000 degrees C} at its surface.',
  A: 'a white star, hotter than the Sun: about {16,000 degrees F|9,000 degrees C} at its surface.',
  F: 'a yellow-white star, a little hotter than the Sun: about {12,000 degrees F|6,500 degrees C} at its surface.',
  G: 'a yellow star like the Sun, about {10,000 degrees F|5,500 degrees C} at its surface.',
  K: 'an orange star, cooler than the Sun: about {7,600 degrees F|4,200 degrees C} at its surface.',
  M: 'a red star, one of the coolest kinds: about {5,500 degrees F|3,000 degrees C} at its surface.'
};
var GIANT_COLOR = { G: 'a yellow', K: 'an orange', M: 'a red' };

// What a star's type says: its colour and heat, and its size or stage of
// life. Nm: its name, or "This star".
function starTypeFacts(Nm, nm, t) {
  var out = [];
  if (!t) return out;
  if (STAR_CLASS[t.cls]) out.push(Nm + ' is ' + STAR_CLASS[t.cls]);
  var hot = t.cls === 'O' || t.cls === 'B';
  if (t.lum === 1) {
    out.push(t.cls === 'M' ? Nm + ' is a red supergiant: put it where the Sun is and it would reach out past the Earth.'
                           : Nm + ' is a supergiant, one of the biggest and most powerful kinds of star.');
  } else if (t.lum === 2) {
    out.push(Nm + ' is a bright giant, much bigger and brighter than the Sun.');
  } else if (t.lum === 3) {
    out.push(GIANT_COLOR[t.cls] ? Nm + ' is ' + GIANT_COLOR[t.cls] + ' giant: an old star that has swollen up as it runs low on fuel.'
                                : Nm + ' is a giant star, several times as wide as the Sun.');
  } else if (t.lum === 4) {
    out.push(Nm + ' is starting to swell up into a giant, as the fuel in its core runs low.');
  } else if (t.lum === 5) {
    if (t.cls === 'G') out.push(Nm + ' is a lot like the Sun: a star in the middle of its life.');
    else if (t.cls === 'K' || t.cls === 'M') out.push(Nm + ' is smaller and cooler than the Sun, and will shine for even longer.');
    else if (hot) out.push('A star as hot as ' + nm + ' burns its fuel fast: it will last a few hundred million years at most.');
    else if (t.cls === 'A') out.push(Nm + ' burns its fuel much faster than the Sun, and will shine for only a fraction as long.');
  } else if (t.lum === 6) {
    out.push(Nm + ' is a white dwarf: the leftover core of a dead star, about as big as the Earth.');
  }
  return out;
}

// Whether a star's written facts already say what a worked-out one does:
// its size (a giant, a supergiant) or its heat.
function saysAlready(own, f) {
  var size = /supergiant|giant/.exec(f), heat = /degrees/.test(f);
  return own.some(function (w) {
    return (heat && /degrees|hottest|coolest/.test(w)) || (!heat && size && /giant/.test(w));
  });
}

var SUN_ABS_MAG = 4.83;   // the Sun's absolute visual magnitude

// How much light a star gives off, from how bright it looks and how far it
// is (visible light; dust on the way is ignored, so far ones are low).
function starPower(Nm, mag, ly) {
  var L = Math.pow(10, (SUN_ABS_MAG - (mag - 5 * Math.log10(ly / LY_PER_PC / 10))) / 2.5);
  if (L >= 1.5) return Nm + ' gives off about ' + about(L) + ' times as much light as the Sun.';
  if (L > 0.67) return Nm + ' gives off about as much light as the Sun.';
  return Nm + ' gives off only about ' + Math.max(1, Math.round(L * 100)) + '% as much light as the Sun.';
}

// How our Sun would look from a star ly light years away.
function sunFrom(nm, ly) {
  var m = SUN_ABS_MAG + 5 * Math.log10(ly / LY_PER_PC / 10);
  var how = m < 2 ? 'a bright star, but nothing special' : m < 3.5 ? 'an ordinary-looking star' :
            m < 5 ? 'a dim star, easy to miss' : m < 6.5 ? 'a very faint star, seen only from dark places' :
            m < 10 ? 'too faint to see without binoculars' : 'too faint to see without a telescope';
  return 'Seen from ' + nm + ', our Sun would be ' + how + '.';
}

// A planet's distance now.
function planetDistance(name, distAU, metric) {
  var m = distAU * (metric ? 149.598 : 92.956);   // millions
  var n = m < 1000 ? about(m) + ' million' : about(m / 1000) + ' billion';
  return name + ' is about ' + n + (metric ? ' km' : ' miles') + ' away right now.';
}

// Venus's phase now (lit: the share of the disc lit).
function venusPhase(lit) {
  if (!(lit > 0) || lit > 0.95) return null;
  var pct = Math.round(lit * 100);
  if (lit < 0.45) return 'Right now Venus is a crescent, only ' + pct + '% lit. Held steady, binoculars can show its shape.';
  if (lit < 0.55) return 'Right now Venus is about half lit, like a quarter Moon. A small telescope shows its shape.';
  return 'Right now Venus is ' + pct + '% lit, like a Moon a few days from full. A small telescope shows its shape.';
}

var EARTH_KM = 12742;
var FULL_NAMES = ['Wolf', 'Snow', 'Worm', 'Pink', 'Flower', 'Strawberry', 'Buck', 'Sturgeon', 'Corn', "Hunter's",
                  'Beaver', 'Cold'];
var SYNODIC_MS = 29.530589 * 86400000;

// The September equinox of a year (the Sun at longitude 180), as ms.
function septemberEquinox(year) {
  var lo = Date.UTC(year, 8, 18), hi = Date.UTC(year, 8, 28);
  for (var i = 0; i < 30; i++) {
    var mid = (lo + hi) / 2;
    var lon = planets.sunEcliptic(mid / 86400000 + 2440587.5 - 2451543.5).lon;
    if (A.wrap180(lon - 180) < 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// The full Moon's name in North American almanacs, if date is within a
// day and a half of full: the Harvest Moon is the full Moon nearest the
// September equinox, the Hunter's Moon the next; the rest by month.
function fullMoonName(date) {
  var t0 = date.getTime(), best = -1, at = 0;
  for (var h = -48; h <= 48; h++) {
    var il = moonMod.moonAltAz(new Date(t0 + h * 3600000), 0, 0).illum;
    if (il > best) {
      best = il;
      at = t0 + h * 3600000;
    }
  }
  if (best < 0.98 || Math.abs(at - t0) > 36 * 3600000) return null;
  var eq = septemberEquinox(new Date(at).getUTCFullYear());
  if (Math.abs(at - eq) <= SYNODIC_MS / 2) return 'Harvest';
  if (Math.abs(at - SYNODIC_MS - eq) <= SYNODIC_MS / 2) return "Hunter's";
  return FULL_NAMES[new Date(at).getMonth()];
}

// The Moon now: {illum, waxing, distKm}; date for the full Moon's name.
function moonNow(s, date, metric) {
  var out = [];
  if (date && s.illum > 0.96) {
    var name = fullMoonName(date);
    if (name === 'Harvest') {
      out.push('This is the Harvest Moon, the full Moon nearest the September equinox, said to light farmers bringing in crops.');
    } else if (name === "Hunter's") {
      out.push("This is the Hunter's Moon: in old North American almanacs, the full Moon after the Harvest Moon.");
    } else if (name) {
      out.push('In North American folk tradition, this full Moon is the ' + name + ' Moon.');
    }
  }
  if (s.illum > 0.03 && s.illum < 0.3) {
    out.push("The dark part of the Moon glows faintly: that's earthshine, sunlight bounced off the Earth.");
  }
  if (s.distKm > 0) {
    if (s.distKm < 362000) out.push('The Moon is near its closest to Earth this month, so it looks a little bigger and brighter.');
    else if (s.distKm > 404000) out.push('The Moon is near its farthest from Earth this month, so it looks a little smaller.');
    var d = metric ? commas(Math.round(s.distKm / 1000) * 1000) + ' km' :
                     commas(Math.round(s.distKm * 0.621371 / 1000) * 1000) + ' miles';
    out.push('The Moon is about ' + d + ' away right now: ' + Math.round(s.distKm / EARTH_KM) +
             ' Earths would fit in the gap.');
  }
  return out;
}

// A plane's trip: {from, to, km}.
function tripFact(t, gs, metric) {
  if (!t || !t.from || !t.to || !(t.km >= 80)) return null;
  var d = metric ? commas(Math.round(t.km / 10) * 10) + ' km' : commas(Math.round(t.km * 0.621371 / 10) * 10) + ' miles';
  var s = t.from + ' to ' + t.to + ' is about ' + d + ' as the crow flies';
  var withTime = gs > 100 ? s + ': ' + minutesText(t.km / (gs * 1.852) * 60) + ' at this speed.' : null;
  return withTime && bytesOf(withTime) <= FACT_MAX ? withTime : s + '.';
}

function bytesOf(s) {
  return unescape(encodeURIComponent(s)).length;
}

var EVEREST_FT = 29032, EMPIRE_FT = 1454, EARTH_MI = 24901;

function planeFacts(p, metric) {
  var out = [];
  if (p.gs > 50) {
    var mph = p.gs * 1.15078;
    var days = EARTH_MI / mph / 24;
    var speed = metric ? commas(Math.round(p.gs * 1.852 / 10) * 10) + ' km/h' : commas(mph) + ' mph';
    out.push('Going ' + speed + ', it could fly all the way around the Earth in ' +
             (days < 1.5 ? 'about a day.' : 'about ' + Math.round(days) + ' days.'));
  }
  if (p.altFt > EVEREST_FT) {
    out.push(metric ? "It's flying higher than the top of Mount Everest (8,849 m)."
                    : "It's flying higher than the top of Mount Everest (29,032 ft).");
  } else if (p.altFt > 2 * EMPIRE_FT) {
    out.push("It's as high as " + Math.round(p.altFt / EMPIRE_FT) + ' Empire State Buildings stacked up.');
  }
  return out;
}

// ---------------------------------------------------------------- choosing

function pickUnits(s, metric) {
  return s.replace(/\{([^|}]*)\|([^}]*)\}/g, function (m, imp, met) { return metric ? met : imp; });
}

// All the facts for one answer. subject: {kind: 'moon'|'planet'|'star'|
// 'constellation'|'sat'|'plane', id (planet id, IAU star name, constellation
// abbreviation, NORAD number, ICAO type code), name, distAU (planets),
// ly (stars), con (a star's constellation abbreviation), train (a
// satellite train's name), rocket (a used rocket stage), gs (knots),
// altFt}. year: the current year (for star light).
function factsFor(subject, opts) {
  var metric = opts.units === 'metric';
  var out = [];
  var s = subject;
  switch (s.kind) {
    case 'moon':
      // What's true only now first: those are the ones worth seeing.
      out = moonNow(s, opts.date, metric).concat(MOON);
      break;
    case 'planet': {
      out = (PLANETS[s.id] || []).slice();
      if (s.distAU > 0) out.push(planetDistance(s.name, s.distAU, metric));
      var vp = s.id === 'venus' ? venusPhase(s.lit) : null;
      if (vp) out.push(vp);
      var pl = planetLight(s.name, s.distAU);
      if (pl) out.push(pl);
      break;
    }
    case 'star': {
      // Its own facts, then what its type, brightness and distance say,
      // its constellation's, and last when its light left it.
      var Nm = s.name || 'This star', nm = s.name || 'this star';
      var cat = s.index >= 0 ? stars.catalog[s.index] : null;
      var own = STARS[s.name] || [];
      out = own.concat(starTypeFacts(Nm, nm, s.index >= 0 ? stars.types[s.index] : null).filter(function (f) {
        return !saysAlready(own, f);
      }));
      if (s.ly > 0 && cat) out.push(starPower(Nm, cat.mag, s.ly), sunFrom(nm, s.ly));
      if (CONSTELLATIONS[s.con]) out.push(CONSTELLATIONS[s.con][0]);
      var sl = starLight(nm, s.ly, opts.year);
      if (sl) out.push(sl);
      break;
    }
    case 'constellation':
      if (CONSTELLATIONS[s.id]) out = CONSTELLATIONS[s.id].slice();
      break;
    case 'pattern':
      // A whole constellation without facts of its own has its constellation's.
      out = (PATTERNS[s.id] || (s.con && CONSTELLATIONS[s.con]) || []).slice();
      break;
    case 'sat':
      out = (SATS[s.id] || (s.train ? (/starlink/i.test(s.train) ? STARLINK : SATELLITE)
                                    : s.rocket ? ROCKET : SATELLITE)).slice();
      break;
    case 'plane': {
      var t = PLANE_BY_CODE[s.id];
      if (t) {
        out = t.facts.slice();
        if (t.seats && t.seats !== '1') out.push('A plane like this carries ' + t.seats + ' people.');
      }
      var tf = tripFact(s.trip, s.gs, metric);
      if (tf) out.push(tf);
      out = out.concat(planeFacts(s, metric));
      break;
    }
  }
  return out.map(function (f) { return pickUnits(f, metric); }).filter(function (f) {
    return bytesOf(f) <= FACT_MAX;   // a long city name can't overflow the card
  });
}

// Which subject a fact is about, for turning to its next fact: the same
// star, planet, constellation, satellite or plane type each time.
function factKey(s) {
  if (s.kind === 'star') return 'star:' + (s.name || s.index);
  if (s.kind === 'sat' && s.train) return 'train:' + s.train;
  return s.kind + ':' + (s.id !== undefined ? s.id : s.name || '');
}

// One fact for a subject: the next of its facts each time it comes up (n:
// how many times it has), never the one shown just before (last), even for
// another subject. Returns {text, n (the count to keep)}, or null when
// there's nothing to say.
function pickFact(subject, opts) {
  var all = factsFor(subject, opts);
  if (!all.length) return null;
  var n = opts.n > 0 ? Math.floor(opts.n) : 0;
  if (all[n % all.length] === opts.last && all.length > 1) n++;
  return { text: all[n % all.length], n: n + 1 };
}

// One fact (the first time round), or ''.
function factFor(subject, opts) {
  var p = pickFact(subject, opts);
  return p ? p.text : '';
}

module.exports = { factFor: factFor, factsFor: factsFor, pickFact: pickFact, factKey: factKey,
                   fullMoonName: fullMoonName, septemberEquinox: septemberEquinox, FACT_MAX: FACT_MAX, LY_PER_PC: LY_PER_PC,
                   STARS: STARS, CONSTELLATIONS: CONSTELLATIONS, PATTERNS: PATTERNS, PLANE_BY_CODE: PLANE_BY_CODE,
                   minutesText: minutesText };
