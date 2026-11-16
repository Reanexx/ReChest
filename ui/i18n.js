'use strict';
/* ReChest i18n. The UI is written in English; with Turkish on, every text node, title, placeholder and
   aria-label is translated as it appears (a MutationObserver), so pages need no per-string wrapping.
   Text is matched whole, then piece by piece around " · ", then against number patterns.
   API for other scripts:  T('English text') -> translated text
                           I18N.add({ 'English': 'Türkçe' }), I18N.rules([[/regex/, 'replacement'], ...])
                           I18N.lang ('en' | 'tr'), I18N.set('tr') (saves and reloads the page). */
(() => {
  let lang = 'en';
  try { lang = localStorage.getItem('rechest.lang') || 'en'; } catch { /* storage blocked */ }
  if (lang !== 'tr') lang = 'en';
  document.documentElement.lang = lang; // so CSS uppercase turns i into İ in Turkish

  const DICT = {
    // navigation and chrome
    'Overview': 'Genel bakış', 'Players': 'Oyuncular', 'Matches': 'Maçlar', 'Simulator': 'Simülatör', 'Settings': 'Ayarlar', 'Map': 'Harita',
    'Theme': 'Tema', 'Back': 'Geri', 'Switch theme (T)': 'Temayı değiştir (T)', 'My profile': 'Profilim', 'Minimise': 'Küçült', 'Maximise': 'Büyüt', 'Close': 'Kapat',
    'Overview (1)': 'Genel bakış (1)', 'Players (2)': 'Oyuncular (2)', 'Matches (3)': 'Maçlar (3)', 'Simulator (4)': 'Simülatör (4)', 'Settings (5)': 'Ayarlar (5)', 'Map (6)': 'Harita (6)', 'Settings (6)': 'Ayarlar (6)', 'Map (5)': 'Harita (5)',
    // overview
    'Just you': 'Sadece sen', 'With squad': 'Takımla', 'Today': 'Bugün', 'Yesterday': 'Dün', '7 days': '7 gün', '30 days': '30 gün', 'All time': 'Tüm zamanlar',
    'Squad chests': 'Takım sandıkları', 'Your chests': 'Senin sandıkların', 'all time': 'tüm zamanlar', 'today': 'bugün',
    'You': 'Sen', 'Teammates': 'Takım arkadaşları', 'Per match': 'Maç başına', 'Best match': 'En iyi maç', 'Per minute': 'Dakika başına',
    'squad average': 'takım ortalaması', 'your average': 'senin ortalaman', 'of match time': 'maç süresinde', 'vs before': 'öncesine göre', 'vs yesterday': 'düne göre',
    'Chests over time': 'Zamana göre sandıklar', 'Per day': 'Gün başına', 'Squad': 'Takım', 'Average': 'Ortalama',
    'Last 40 matches · hover for details, click to open a match': 'Son 40 maç · ayrıntı için üzerine gel, açmak için tıkla',
    'Per day · hover to see each day': 'Gün başına · her günü görmek için üzerine gel',
    'Live match': 'Canlı maç', 'Last match': 'Son maç', 'Recent matches': 'Son maçlar', 'All': 'Tümü', 'ALL': 'TÜMÜ', 'LIVE': 'CANLI', 'Live': 'Canlı',
    'chests added with your hotkey': 'sandık kısayolunla eklendi', 'The replay sets the exact count, teammates included, when the match ends.': 'Maç bitince replay, takım arkadaşları dahil kesin sayıyı belirler.',
    'squad chests': 'takım sandığı', 'Open match': 'Maçı aç', 'No matches yet': 'Henüz maç yok',
    'When in the match': 'Maçın hangi anında', 'No chests yet': 'Henüz sandık yok', 'first chest, on average': 'ortalama ilk sandık',
    'in the first 4 minutes': 'ilk 4 dakikada', 'after minute 16': '16. dakikadan sonra', 'After minute 16': '16. dakikadan sonra',
    'Opened vs broken': 'Açılan ve kırılan', 'Opening chests vs breaking them': 'Sandık açmak ve kırmak', 'Opened': 'Açılan', 'Broken': 'Kırılan',
    'of your chests broken': 'sandığını kırarak aldın', 'teammates’ broken': 'arkadaşların kırdı', 'broken per match': 'maç başına kırılan',
    'Placement vs chests': 'Sıralama ve sandıklar', 'Win': 'Galibiyet', 'Top 5': 'İlk 5', 'Top 10': 'İlk 10', 'Top 25': 'İlk 25', 'Lower': 'Daha aşağı',
    'Wins average': 'Galibiyetlerde ortalama', 'the chests of placements below 25th.': 'sandık var; 25. sıranın altına göre.',
    'average placement': 'ortalama sıralama', 'win': 'galibiyet', 'wins': 'galibiyet', 'best placement': 'en iyi sıralama',
    'Squad leaderboard': 'Takım sıralaması', 'Player': 'Oyuncu', 'Chests': 'Sandıklar', 'Best': 'En iyi', 'Last 10': 'Son 10', 'YOU': 'SEN',
    'No players in this range': 'Bu aralıkta oyuncu yok',
    // goal / activity / records
    'Daily goal': 'Günlük hedef', 'Lower goal': 'Hedefi düşür', 'Raise goal': 'Hedefi yükselt', 'Goal reached today': 'Bugünkü hedefe ulaşıldı',
    'at your goal': 'hedefinde', 'in matches today': 'bugün maçlarda', 'best goal streak': 'en iyi hedef serisi', 'goal': 'hedef',
    'Activity': 'Aktivite', 'Your chests per day · last 26 weeks': 'Günlük sandıkların · son 26 hafta', 'Less': 'Az', 'More': 'Çok',
    'in matches, all time': 'maçlarda, tüm zamanlar', 'your chests per hour': 'saatte sandığın', 'per match': 'maç başına',
    'Records': 'Rekorlar', 'Share': 'Paylaş', 'Best day': 'En iyi gün', 'Fastest first chest': 'En hızlı ilk sandık', 'no matches yet': 'henüz maç yok',
    'First chest': 'İlk sandık', 'Looter': 'Yağmacı', 'Vault raider': 'Kasa avcısı', 'Century': 'Yüzlük', 'On fire': 'Alev aldı', 'Week warrior': 'Hafta savaşçısı',
    'Speedrunner': 'Hızlı koşucu', 'Winner’s loot': 'Kazananın ganimeti', 'Squad carry': 'Takımı taşıyan', 'Thousand': 'Bin',
    'Open your first chest': 'İlk sandığını aç', '20 of your chests in one match': 'Bir maçta 20 sandık', '40 of your chests in one match': 'Bir maçta 40 sandık',
    '100 of your chests in one day': 'Bir günde 100 sandık', 'Hit your daily goal 3 days in a row': 'Günlük hedefi 3 gün üst üste tuttur',
    'Hit your daily goal 7 days in a row': 'Günlük hedefi 7 gün üst üste tuttur', 'First chest within 30 seconds': '30 saniye içinde ilk sandık',
    'Win a match with 15+ of your chests': '15+ sandıkla maç kazan', 'More chests than the rest of the squad combined (10+)': 'Takımın geri kalanından fazla sandık (10+)',
    '1,000 chests in total': 'Toplam 1.000 sandık', 'unlocked': 'açıldı', 'locked': 'kilitli',
    'Daily goal reached!': 'Günlük hedefe ulaştın!', 'not counted as chests': 'sandık sayılmaz',
    'Chest': 'Sandık', 'Faction chest': 'Grup sandığı', 'Ammo box': 'Mermi kutusu', 'Supply drop': 'Destek paketi', 'Supply llama': 'Destek laması', 'Fishing barrel': 'Balık fıçısı', 'Gift box': 'Hediye kutusu',
    'Image copied': 'Görsel kopyalandı', 'Paste it anywhere': 'İstediğin yere yapıştır', 'Could not copy': 'Kopyalanamadı', 'Use Save PNG instead': 'Bunun yerine PNG kaydet',
    'Copy image': 'Görseli kopyala', 'Save PNG': 'PNG kaydet',
    // players
    'Everyone': 'Herkes', 'Search players': 'Oyuncu ara', 'No player found': 'Oyuncu bulunamadı', 'Squad view': 'Takım görünümü',
    'Chests per match': 'Maç başına sandık', 'Total': 'Toplam', 'Rank': 'Sıra', 'Peak': 'Zirve', 'Growth': 'Büyüme', 'Daily': 'Günlük', 'This week': 'Bu hafta',
    'No data yet': 'Henüz veri yok', 'Click to open the match': 'Maçı açmak için tıkla',
    // matches
    'Newest': 'En yeni', 'Most chests': 'En çok sandık', 'Best placement': 'En iyi sıralama', 'All tags': 'Tüm etiketler',
    'Timeline': 'Zaman çizelgesi', 'Chests over the match · hover to read any moment': 'Maç boyunca sandıklar · herhangi bir anı okumak için üzerine gel',
    'Containers': 'Kaplar', 'No containers this match': 'Bu maçta kap yok', 'No containers yet': 'Henüz kap yok', 'No matches for this player': 'Bu oyuncunun maçı yok',
    'Hot drop': 'Sıcak iniş', 'Good loot': 'İyi ganimet', 'Bad luck': 'Kötü şans', 'Practice': 'Antrenman', 'Clutch': 'Clutch', 'Ranked': 'Dereceli', '+ Tag': '+ Etiket', 'Add a tag': 'Etiket ekle',
    'broken': 'kırıldı', 'other': 'diğer', 'you': 'sen', 'squad': 'takım',
    // simulator
    'Chest simulator': 'Sandık simülatörü', 'Treasure Hunters odds published by Epic · Space opens a chest': 'Epic’in yayınladığı Hazine Avcıları oranları · Boşluk sandık açar',
    'Chests opened': 'Açılan sandık', 'Target': 'Hedef', 'Open chest': 'Sandık aç', 'Space': 'Boşluk', 'Open until I get it': 'Çıkana kadar aç', 'Stop hunting': 'Avı durdur',
    'Fast mode': 'Hızlı mod', 'Treasure Hours': 'Hazine Saatleri', 'Weekly limit': 'Haftalık sınır', 'Sound': 'Ses', 'Reset': 'Sıfırla',
    'Pick your target': 'Hedefini seç', 'Recent drops': 'Son çıkanlar', 'Open a chest: anything rare lands here': 'Sandık aç: nadir çıkanlar burada görünür',
    'Odds per chest': 'Sandık başına oranlar', 'Every reward is rolled on its own, each chest': 'Her ödül her sandıkta ayrı ayrı çekilir',
    'Token facts': 'Token bilgileri', 'Pirate Shop Access token, from your replays': 'Korsan Dükkânı Erişim tokenı, replay’lerinden',
    'Reward': 'Ödül', 'Odds': 'Oran', 'Per chest': 'Sandık başına', '50% after': '%50 için', 'No treasure this time': 'Bu sefer hazine yok', 'YOU GOT IT!': 'ÇIKTI!', 'Keep opening': 'Açmaya devam',
    'Any Gizmo': 'Herhangi bir Gizmo', 'Weekly Loading Screen': 'Haftalık Yükleme Ekranı', 'Weekly Jam Track': 'Haftalık Jam Parçası', 'Weekly Pickaxe or Back Bling': 'Haftalık Kazma veya Sırt Süsü',
    'Weekly Vehicle & Decal': 'Haftalık Araç ve Çıkartma', 'Pirate Shop Access token': 'Korsan Dükkânı Erişim tokenı', 'Weekly Gold Outfit': 'Haftalık Altın Kıyafet',
    'Uncommon': 'Sıradışı', 'Rare': 'Nadir', 'Epic': 'Destansı', 'Legendary': 'Efsanevi', 'Mythic': 'Mitik', 'Exotic': 'Egzotik', 'Common': 'Sıradan',
    'chests per token on average': 'token başına ortalama sandık',
    // settings
    'In-game overlay, hotkeys and appearance': 'Oyun içi panel, kısayollar ve görünüm', 'In-game overlay': 'Oyun içi panel', 'Hotkeys': 'Kısayollar',
    'Appearance': 'Görünüm', 'Replays': 'Replay’ler', 'About': 'Hakkında', 'Broadcast': 'Yayın', 'Language': 'Dil',
    'In-game panel': 'Oyun içi panel', 'Your own chests over Fortnite, only while it is the active window. It can’t be clicked, so it never takes focus from the game.': 'Kendi sandıkların Fortnite’ın üstünde, yalnızca oyun öndeyken. Tıklanamaz, yani oyundan odağı almaz.',
    'Corner': 'Köşe', 'Top left': 'Sol üst', 'Top right': 'Sağ üst', 'Bottom left': 'Sol alt', 'Bottom right': 'Sağ alt', 'Offset X': 'Kaydırma X', 'Offset Y': 'Kaydırma Y',
    'Size': 'Boyut', 'Opacity': 'Opaklık', 'Style': 'Stil', 'Glass': 'Cam', 'Solid': 'Düz', 'Minimal': 'Sade', 'Accent': 'Vurgu rengi', 'Custom colour': 'Özel renk',
    'Show “+this match”': '“+bu maç” göster', 'The live number next to the total': 'Toplamın yanındaki canlı sayı', 'Show labels': 'Etiketleri göster',
    'The CHESTS / THIS MATCH captions': 'SANDIK / BU MAÇ yazıları', 'Show hotkey hints': 'Kısayol ipuçlarını göster', 'Preview': 'Önizleme', 'How it sits on a 1080p game': '1080p oyunda nasıl durduğu', 'Actual size': 'Gerçek boyut',
    'CHESTS': 'SANDIK', 'THIS MATCH': 'BU MAÇ',
    'Count your chests during a match with a key, including chests broken from below. The replay sets the exact count when the match ends.': 'Maç sırasında sandıklarını bir tuşla say, alttan kırdıkların dahil. Maç bitince replay kesin sayıyı belirler.',
    'Add a chest': 'Sandık ekle', 'Press during a match': 'Maç sırasında bas', 'Remove a chest': 'Sandık çıkar', 'Undo a wrong count': 'Yanlış sayımı geri al', 'Press a key…': 'Bir tuşa bas…', 'Your Fortnite keys': 'Fortnite tuşların',
    'Black': 'Siyah', 'Blue': 'Mavi', 'Light': 'Açık', 'Windows': 'Windows', 'Animations': 'Animasyonlar', 'Chart and card entrance motion': 'Grafik ve kart giriş hareketleri',
    'Background': 'Arka plan', 'Behind every page. Only on this PC.': 'Her sayfanın arkasında. Sadece bu bilgisayarda.', 'Colour': 'Renk', 'Picture': 'Resim',
    'Pick any colour; the page shades it from light to dark': 'Bir renk seç; sayfa onu açıktan koyuya tonlar', 'Shown behind the pages, filling the window': 'Sayfaların arkasında, pencereyi doldurarak',
    'Choose a picture from your PC': 'Bilgisayarından bir resim seç', 'Choose': 'Seç', 'Remove': 'Kaldır', 'Darken': 'Karart', 'Keeps text readable on busy pictures': 'Karışık resimlerde yazıyı okunur tutar', 'Blur': 'Bulanıklık',
    'Picture too large': 'Resim çok büyük', 'Try a smaller image': 'Daha küçük bir resim dene', 'Could not read that picture': 'Bu resim okunamadı',
    'The frosted, see-through look of the panels and bars': 'Panellerin ve çubukların buzlu, saydam görünümü', 'Glass effect': 'Cam efekti', 'Off makes every panel solid': 'Kapalıyken bütün paneller düz olur',
    'How much the background is frosted behind panels': 'Panellerin arkasının ne kadar buzlanacağı', 'Panel opacity': 'Panel opaklığı', 'Higher is more solid; lower lets the background show through': 'Yüksek daha düz; düşük arka planı gösterir',
    'Sounds': 'Sesler', 'A short chime for new matches, live chests and your daily goal': 'Yeni maç, canlı sandık ve günlük hedef için kısa bir ses', 'Volume': 'Ses düzeyi',
    'Replay folder': 'Replay klasörü', 'Found. Matches are read a few seconds after they end.': 'Bulundu. Maçlar bittikten birkaç saniye sonra okunur.', 'Open': 'Aç',
    'Made with': 'Yapan:', 'by Reanex': 'Reanex',
    'Chest analytics from your Fortnite replays. Chest pictures: Fortnite Wiki. Skins: fortnite-api.com. Not affiliated with Epic Games.': 'Fortnite replay’lerinden sandık analizi. Sandık resimleri: Fortnite Wiki. Kostümler: fortnite-api.com. Epic Games ile bağlantılı değildir.',
    // broadcast (hidden panel)
    'Secret unlocked': 'Gizli panel açıldı', 'Send': 'Gönder', 'Sent ✓': 'Gönderildi ✓', 'Receive others’ broadcasts': 'Başkalarının yayınlarını al', 'Let others start the video on your screen': 'Başkaları videoyu senin ekranında başlatabilsin',
    'Play the video over the screen of everyone running ReChest. Only a “play” signal is sent; each app plays its own video.': 'Videoyu ReChest kullanan herkesin ekranında oynat. Yalnızca “oynat” sinyali gider; her uygulama kendi videosunu oynatır.',
    'Recent broadcasts': 'Son yayınlar', 'No broadcasts in the last 12 hours': 'Son 12 saatte yayın yok', 'Loading recent broadcasts…': 'Son yayınlar yükleniyor…', 'just now': 'az önce',
    'In a match': 'Maçta', 'Squad chests per match by final placement': 'Son sıralamaya göre maç başına takım sandığı',
    'Your chests per match by final placement': 'Son sıralamaya göre maç başına sandığın', 'click a player for their profile': 'profili için oyuncuya tıkla',
    'Last 10 matches': 'Son 10 maç', 'Open a match': 'Bir maç aç',
    'Character': 'Karakter', 'Burst': 'Patlama', 'Stripes': 'Çizgili', 'Grid': 'Izgara', 'Clean': 'Sade', 'Per hour': 'Saatlik', 'In matches': 'Maçlarda',
    'Record alerts': 'Rekor bildirimleri', 'During a match: how close you are to your best match, and “New record!” when you pass it': 'Maç sırasında en iyi maçına ne kadar yaklaştığın ve geçince “Yeni rekor!”',
    'New record!': 'Yeni rekor!',
    'Startup': 'Başlangıç', 'ReChest runs quietly in the background and stays light: one check every few seconds, the window wakes only when needed.': 'ReChest arka planda sessizce ve hafif çalışır: birkaç saniyede bir kontrol, pencere yalnızca gerekince uyanır.',
    'Start with Windows': 'Windows ile başlat', 'Starts hidden in the tray when you sign in': 'Oturum açınca simge durumunda gizli başlar',
    'Show when Fortnite starts': 'Fortnite açılınca göster', 'Pops up the window (without taking focus) when the game launches': 'Oyun açılınca pencereyi gösterir (odağı almadan)',
    'Keep running when closed': 'Kapatınca arka planda çalışsın', 'The close button hides ReChest to the tray; quit from the tray icon': 'Kapat düğmesi ReChest’i sistem tepsisine gizler; tepsi simgesinden çıkabilirsin',
    // toasts
    'Match started': 'Maç başladı', 'Add chests with your hotkey; the replay sets the exact count at the end': 'Sandıkları kısayolunla ekle; maç sonunda replay kesin sayıyı belirler',
    'Match added:': 'Maç eklendi:', 'by you,': 'senden,', 'by the squad': 'takımdan',
  };
  // patterns for text with numbers; $1.. keep the numbers
  const N = '([\\d.,]+)';
  const RULES = [
    [`^${N} matches?$`, '$1 maç'], [`^${N} opened$`, '$1 açıldı'], [`^${N} broken$`, '$1 kırıldı'], [`^${N} other$`, '$1 diğer'],
    [`^${N} min$`, '$1 dk'], [`^${N} elims$`, '$1 eleme'], [`^${N} players$`, '$1 oyuncu'], [`^${N} shown$`, '$1 gösteriliyor'],
    [`^${N} squad chests$`, '$1 takım sandığı'], [`^${N} chests?$`, '$1 sandık'], [`^${N} chests opened$`, '$1 sandık açıldı'], [`^${N} chests a day$`, 'günde $1 sandık'],
    [`^${N} matches read from your replays$`, 'replay’lerden $1 maç okundu'], [`^${N} backed up$`, '$1 yedeklendi'],
    [`^${N} other containers not counted$`, '$1 diğer kap sayılmadı'], [`^${N} more players$`, '$1 oyuncu daha'], [`^\\+${N} more players$`, '+$1 oyuncu daha'], [`^\\+${N} more$`, '+$1 daha'],
    [`^${N} of your chests a day$`, 'günde $1 sandığın'], [`^${N} more to go today$`, 'bugün $1 tane kaldı'], [`^of ${N} today$`, 'bugün hedef $1'],
    [`^days? in a row$`, 'gün üst üste'], [`^${N} of ${N} badges unlocked$`, '$2 rozetten $1 tanesi açıldı'],
    [`^days? played in a row$`, 'gün üst üste oynandı'], [`^${N} of your chests$`, '$1 sandığın'], [`^${N} by you$`, 'senden $1'],
    [`^${N} of your chests · ${N} matches$`, '$1 sandığın · $2 maç'], [`^${N} in matches$`, 'maçlarda $1'],
    [`^Most chests between minute ${N} and ${N}$`, 'En çok sandık $1. ile $2. dakika arasında'], [`^Minute ${N}–${N}$`, '$1–$2. dakika'],
    [`^last ${N} days$`, 'son $1 gün'], [`^vs previous ${N} days$`, 'önceki $1 güne göre'], [`^Placed #${N}$`, '#$1 bitirdi'],
    [`^${N} chests on average$`, 'ortalama $1 sandık'], [`^${N}% broken$`, '%$1 kırıldı'], [`^${N} min ago$`, '$1 dk önce'], [`^${N} h ago$`, '$1 sa önce'],
    [`^Opened ${N}%$`, 'Açılan %$1'], [`^Broken ${N}%$`, 'Kırılan %$1'], [`^${N} chests · no treasure$`, '$1 sandık · hazine yok'],
    [`^Stopped after ${N} chests$`, '$1 sandıktan sonra durduruldu'], [`^Hunting (.+)…$`, '$1 avlanıyor…'], [`^This session$`, 'Bu oturum'],
    [`^${N} replays backed up$`, '$1 replay yedeklendi'], [`^${N} MB$`, '$1 MB'], [`^This match: ${N}$`, 'Bu maç: $1'], [`^\\+${N} chest$`, '+$1 sandık'],
    [`^${N} chests this match · your best was ${N}$`, 'bu maçta $1 sandık · önceki rekorun $2'], [`^${N} more$`, '$1 daha'], ['^(\\d+)h (\\d+)m$', '$1 sa $2 dk'], ['^(\\d+)m$', '$1 dk'], [`^${N}%$`, '%$1'], [`^${N} chests per match$`, 'maç başına $1 sandık'], [`^${N} match$`, '$1 maç'], [`^${N} matches · ${N} squad chests$`, '$1 maç · $2 takım sandığı'],
  ].map(([re, to]) => [new RegExp(re, 'i'), to]);

  function one(s) {
    if (DICT[s] != null) return DICT[s];
    for (const [re, to] of RULES) if (re.test(s)) return s.replace(re, (...m) => to.replace(/\$(\d)/g, (_, i) => DICT[m[i]] ?? m[i]));
    return null;
  }
  /** Translates a whole string: as is, else each " · " piece, keeping surrounding spaces. */
  function T(s) {
    if (lang !== 'tr' || !s) return s;
    const lead = s.match(/^\s*/)[0], trail = s.match(/\s*$/)[0], core = s.trim();
    if (!core || !/[A-Za-z]/.test(core)) return s;
    let out = one(core);
    if (out == null && core.includes(' · ')) {
      const parts = core.split(' · ').map((p) => one(p.trim()) ?? p);
      out = parts.join(' · ');
    }
    return out == null ? s : lead + out + trail;
  }
  const ATTRS = ['title', 'placeholder', 'aria-label'];
  function walk(root) {
    if (lang !== 'tr' || !root) return;
    if (root.nodeType === 3) { const t = T(root.data); if (t !== root.data) root.data = t; return; }
    if (root.nodeType !== 1 || root.closest?.('script, style, svg, .no-tr')) return;
    for (const a of ATTRS) if (root.hasAttribute?.(a)) { const v = root.getAttribute(a), t = T(v); if (t !== v) root.setAttribute(a, t); }
    const it = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let n = it.nextNode(); n; n = it.nextNode()) {
      if (n.nodeType === 3) { if (!n.parentElement?.closest('script, style, .no-tr, input, textarea')) { const t = T(n.data); if (t !== n.data) n.data = t; } }
      else for (const a of ATTRS) if (n.hasAttribute(a)) { const v = n.getAttribute(a), t = T(v); if (t !== v) n.setAttribute(a, t); }
    }
  }
  if (lang === 'tr') {
    const start = () => {
      walk(document.body);
      new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) walk(n); }).observe(document.body, { childList: true, subtree: true });
    };
    document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', start) : start();
  }
  window.T = T;
  window.I18N = {
    get lang() { return lang; },
    locale: lang === 'tr' ? 'tr-TR' : 'en-US',
    add(map) { Object.assign(DICT, map); },
    rules(list) { for (const [re, to] of list) RULES.push([re instanceof RegExp ? re : new RegExp(re, 'i'), to]); },
    set(l) { try { localStorage.setItem('rechest.lang', l === 'tr' ? 'tr' : 'en'); } catch { /* ignore */ } location.reload(); },
  };
})();
