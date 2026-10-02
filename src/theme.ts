import { invoke } from '@tauri-apps/api/core';

// Each theme's CSS lives in App.css under :root[data-theme="..."]; `accent`
// mirrors its --accent for the settings swatches, and `icon` is the radial
// gradient behind the white tree in the app icon.
export const THEMES = {
  forest: { label: 'Forest', accent: '#00ff87', icon: ['#16492c', '#04100a'] },
  spring: { label: 'Spring', accent: '#a8e063', icon: ['#3d5a1c', '#0b1206'] },
  summer: { label: 'Summer', accent: '#ffc93c', icon: ['#7a5410', '#140d03'] },
  autumn: { label: 'Autumn', accent: '#ff7b39', icon: ['#7a2e0e', '#140704'] },
  winter: { label: 'Winter', accent: '#9fd8ff', icon: ['#24477a', '#050a14'] },
  cherry: { label: 'Cherry Blossom', accent: '#ff8fc7', icon: ['#7a2952', '#14060d'] },
} as const;

export type ThemeName = keyof typeof THEMES;

// ponytail: hemisphere guessed from the timezone name; add a manual
// override if someone outside these zones wants auto mode.
const SOUTHERN_TZ =
  /^(Australia|Antarctica)\/|^Pacific\/(Auckland|Chatham|Fiji|Tongatapu|Noumea|Efate)|^America\/(Argentina|Santiago|Sao_Paulo|Montevideo|Asuncion|La_Paz|Lima|Punta_Arenas)|^Africa\/(Johannesburg|Maputo|Harare|Windhoek|Gaborone|Lusaka|Maseru|Mbabane|Blantyre)|^Indian\/(Mauritius|Reunion|Antananarivo)/;

// Meteorological seasons, with cherry blossom taking the middle month of
// spring (April up north, October down south).
export const seasonFor = (date: Date, southern: boolean): ThemeName => {
  const month = (date.getMonth() + (southern ? 6 : 0)) % 12;
  if (month === 3) return 'cherry';
  if (month >= 2 && month <= 4) return 'spring';
  if (month >= 5 && month <= 7) return 'summer';
  if (month >= 8 && month <= 10) return 'autumn';
  return 'winter';
};

export const currentSeason = () =>
  seasonFor(new Date(), SOUTHERN_TZ.test(Intl.DateTimeFormat().resolvedOptions().timeZone));

// Redraws the app icon (white tree over the theme's gradient, matching
// app-icon.png's layout) and hands it to the backend to set as the dock /
// window icon. Runtime only - the bundled icon on disk stays Forest.
const setAppIcon = async (theme: ThemeName) => {
  const logo = new Image();
  logo.src = '/logo.png';
  await logo.decode();
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const [inner, outer] = THEMES[theme].icon;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size * 0.72);
  gradient.addColorStop(0, inner);
  gradient.addColorStop(1, outer);
  ctx.fillStyle = gradient;
  // macOS only masks bundled icons, so draw its rounded-square shape and
  // margin ourselves (824/1024 body, ~185 radius) to sit level with the
  // other dock icons.
  const inset = size * (100 / 1024);
  ctx.beginPath();
  ctx.roundRect(inset, inset, size - inset * 2, size - inset * 2, size * (185 / 1024));
  ctx.fill();
  const w = size * 0.48;
  const h = (w * logo.height) / logo.width;
  ctx.drawImage(logo, (size - w) / 2, (size - h) / 2, w, h);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) return;
  const png = Array.from(new Uint8Array(await blob.arrayBuffer()));
  await invoke('set_app_icon', { png });
};

export const applyTheme = (theme: ThemeName) => {
  document.documentElement.dataset.theme = theme;
  setAppIcon(theme).catch((err) => console.error('Failed to set app icon:', err));
};
