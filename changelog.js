// "What's new" – shown from the version badge in the top bar. Newest first.
// Add an entry here with every release (and bump the ?v= numbers in index.html / app.js).
export const CHANGELOG = [
  {
    version: '1.7', date: '2026-09-30', title: 'Update log',
    items: ['This “What’s new” list – tap the version badge at the top any time.'],
  },
  {
    version: '1.6', date: '2026-09-30', title: 'Scanner compares pictures',
    items: [
      'After reading the card, the scanner compares your photo with the pictures of the closest cards and picks the one that looks most alike.',
      'Regular cards win over look-alike special versions (like “Poke Ball Pattern”) unless your photo clearly shows the special one.',
      'A green “Best match” badge marks the winner when the scanner is sure.',
    ],
  },
  {
    version: '1.5', date: '2026-09-30', title: 'Smarter scanning',
    items: [
      'Everything the camera reads – number, set size, set code, name – is checked against the whole card list, forgiving common misreads (0/O/8, 1/l/7, 5/S…).',
      'Camera scans are faster: only the name and number areas are read.',
    ],
  },
  {
    version: '1.4', date: '2026-09-29', title: 'Every card, wishlist & checklists',
    items: [
      'Almost every English and Japanese card (about 56,000) with pictures, from 1996 to the newest sets.',
      'New sets are added automatically every day.',
      '☆ Wishlist: tap “Add to wishlist” on any card.',
      'Checklists: every card of a Pokémon (e.g. “All Umbreon”) or a whole set, with progress bars.',
      'Search Japanese cards by their English name.',
      'TCGplayer market price and link on each card.',
    ],
  },
  {
    version: '1.3', date: '2026-09-29', title: 'Camera frame',
    items: [
      'Live camera with a card-shaped frame, so the scanner always sees the whole card.',
      'Japanese cards are found by set code + number (e.g. “SV4a 105/190”).',
    ],
  },
  {
    version: '1.2', date: '2026-09-29', title: 'Japanese cards',
    items: ['English / Japanese switch, JP tags on Japanese cards, and “Add it yourself” for cards missing from the list.'],
  },
  {
    version: '1.0', date: '2026-09-29', title: 'First version',
    items: [
      'Scan or search cards and add them to binders.',
      'Multiple binders with custom covers – colours, patterns, stickers, a card or your own photo.',
      'Sign in to sync your binders between your phone and computer.',
    ],
  },
];
