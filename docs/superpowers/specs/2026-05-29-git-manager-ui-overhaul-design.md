# Git Manager — Perombakan UI/UX (Desain)

- **Tanggal:** 2026-05-29
- **Ekstensi:** `extensions-bundled/git-manager/`
- **Status:** Disetujui (brainstorming) — siap dipecah jadi rencana implementasi
- **Arah visual:** Hybrid — *Refined Flat* (basis, gaya Linear/GitHub-dark) + diff dengan *syntax highlighting* (diambil dari arah *Editor-native*)

## 1. Tujuan & konteks

Git Manager adalah panel ekstensi (HTML + JS + CSS vanila, tanpa build step) yang menjalankan `git` terhadap `root_dir` sebuah app lewat `window.portaBridge`. Sudah matang & kaya fitur (7 tab: Status, Branches, Sync, History, Rebase, Stash, Tags), tapi tampilannya bisa di-level-up.

Pengguna meminta perombakan UI/UX menyeluruh untuk **setiap fitur**, dengan penekanan khusus pada tiga jenis "highlight":
1. **Diff highlighting** — termasuk word-level dan syntax.
2. **Selection / active highlight** — penanda baris/row terpilih, tab aktif, current branch.
3. **Search-match highlight** — menandai teks yang cocok saat filter/search.

Arah visual yang disetujui: **density tetap rapat** (panel kecil di dalam app-card, melihat lebih banyak baris = UX lebih baik), aksen tunggal, plus diff yang jauh lebih mudah dibaca.

### Non-tujuan (YAGNI)
- Tidak mengubah perilaku git apa pun (operasi, IPC, semantik staging).
- Tidak mengganti arsitektur (tetap vanila + helper `h()`).
- Tidak menambah library eksternal / network / build step.
- Tidak menyentuh Rust (`src-tauri/`) atau ekstensi lain.

## 2. Berkas yang disentuh

| Berkas | Perubahan |
|--------|-----------|
| `style.css` | Tulis ulang besar mengikuti sistem baru |
| `app.js` | Penyesuaian rendering: gutter diff, word-level diff, syntax highlighting, search-match wrap, kelas baris seragam |
| `index.html` | Minor (markup tab/topbar bila perlu, template) |
| `porta.json` | Bump versi |
| `README.md` | Catat perubahan UI |

Versi dilacak di `porta.json` saja untuk ekstensi (bukan trio package.json/Cargo seperti app utama).

## 3. Sistem dasar (fondasi)

- **Ritme spacing** berbasis grid 4px; skala radius konsisten (mis. 4 / 6 / 8 / 10 px).
- **Satu aksen** biru untuk active/selection; warna semantik status dipakai identik di semua list:
  - amber = modified, emerald = added, merah = deleted, biru = renamed, abu = untracked.
- **Tombol aksi tidak lagi tersembunyi.** Saat ini `opacity:0` sampai hover (discoverability buruk). Baru: **samar tapi terlihat** saat diam (≈0.5–0.6 opacity / warna dim), penuh saat hover atau baris terpilih. Gaya ghost-icon dengan `title` tooltip.
- **Focus-visible ring** untuk navigasi keyboard di tombol & baris yang interaktif.
- State hover/active konsisten lintas komponen (satu definisi `--bg-hover`, `--bg-selected`).

## 4. Penampil diff (Status + History) — inti utama

### 4.1 Gutter nomor baris
- Kolom nomor baris (lama/baru) di kiri tiap baris diff, monospace, `user-select:none`.
- Parser diff diperluas untuk melacak nomor baris berjalan dari header hunk `@@ -a,b +c,d @@`.
- Berlaku untuk unified **dan** split view; di split, tiap sisi punya gutter sendiri.

### 4.2 Word-level highlight
- Untuk run baris `-`/`+` yang berpasangan, hitung diff level kata/token sederhana (LCS atas token) dan bungkus hanya bagian yang berubah dengan `<span class="wd-del">` / `<span class="wd-add">`.
- Bila pasangan tak setara (jumlah `-` ≠ `+`), fallback: baris diberi tint penuh seperti sekarang (tanpa word highlight) — tidak menebak-nebak.

### 4.3 Syntax highlighting
- Modul kecil terisolasi (±150 baris, regex-based, mirip mini-highlight.js) di dalam `app.js` atau berkas pendamping.
- Bahasa didukung awal: JS/TS/JSX, JSON, CSS/SCSS, HTML, Markdown, shell, Rust, Python. Dipilih dari ekstensi nama file.
- Token diwarnai (keyword/violet, string/emerald-ish, number/amber, comment/dim) **di lapisan bawah** tint add/del — tint diff tetap menang sebagai sinyal utama.
- **Fallback mulus**: ekstensi tak dikenal atau parsing gagal → render polos (perilaku sekarang). Syntax highlighting tidak boleh bisa merusak/menyembunyikan isi diff.

### 4.4 Bar aksi per-hunk
- Affordance lebih jelas & terlihat permanen (mengikuti aturan §3). Semantik Stage hunk / Unstage hunk / Discard **tetap identik**.

## 5. List seragam (Status / Branches / History / Stash / Tags / Remotes)

- **Template baris seragam:** `[glyph/chip status] [teks utama: dir diredupkan + nama dicerahkan] [meta] [aksi]`.
- **Selection lebih kuat:** background + aksen garis-kiri + teks nama lebih terang.
- **Current branch** lebih jelas (marker + warna emerald, konsisten dgn branch-chip topbar).
- **Search-match highlight:** setiap kotak filter/search membungkus substring yang cocok dengan `<mark class="hl">`:
  - Status filter, Branches filter, History search, Tags filter.
  - Pencocokan case-insensitive; escape HTML dulu, baru sisipkan `<mark>` (hindari XSS dari nama file/branch).
- **Empty state ramah** saat filter tidak menghasilkan baris ("Tidak ada yang cocok dengan '…'").

## 6. Polish per-tab

- **Tabs / topbar:** lebih rapat; badge **selalu menyediakan ruang** (hindari layout shift saat badge muncul/hilang); branch-chip dengan delta ahead/behind dirapikan.
- **Sync:** kartu aksi diberi ikon, state running/disabled lebih jelas, header ringkasan dirapikan; baris remote memakai template list baru (§5).
- **Rebase:** baris todo diberi warna per-aksi (pick/squash/fixup/drop), grip drag jelas, baris `is-drop` tetap strikethrough; banner in-progress dirapikan.
- **Stash / Tags:** template baris baru, aksi terlihat permanen.
- **Toast / modal / empty state / spinner:** disesuaikan dengan sistem baru (radius, warna, spacing).

## 7. Invarian (tidak boleh rusak)

- Semua operasi git & IPC `portaBridge` tetap.
- Shortcut keyboard: `1`–`7` pindah tab, `R` refresh, `⌘↵`/`Ctrl↵` commit.
- Semantik per-hunk staging (`git apply --cached` / `--reverse`) tetap.
- Hanya melihat `app.root_dir`; tetap hanya butuh permission `shell`.

## 8. Strategi validasi

Karena ini ekstensi WebView murni (Tidewave bisa lihat), validasi:
1. `node_modules/.bin/tsc --noEmit` tidak relevan (ekstensi bukan TS) — lewati; tapi pastikan tidak ada syntax error JS.
2. Muat ulang ekstensi di Porta, buka tiap tab, pastikan:
   - Tidak ada error console.
   - Diff tampil dengan gutter + word highlight + syntax (file dikenal) dan polos (file tak dikenal).
   - Filter/search menandai match.
   - Semua aksi (stage/unstage/discard/commit/branch/sync/rebase/stash/tag) tetap jalan.
3. Cek beberapa kasus: repo bersih, banyak file, file untracked besar, rebase paused, tanpa remote.

## 9. Risiko & mitigasi

| Risiko | Mitigasi |
|--------|----------|
| Tokenizer syntax bikin diff salah/lambat | Modul kecil terisolasi + fallback polos; render per-baris, tidak blocking |
| `<mark>` dari nama file → XSS | Escape HTML dulu sebelum sisip highlight |
| Gutter bikin baris panjang ter-wrap aneh | `white-space:pre` + gutter lebar tetap, non-select |
| Regresi fungsional dari refactor render | Ubah presentasi saja; pertahankan struktur handler & dataset hooks |

## 10. Urutan implementasi (disarankan)

1. Sistem dasar CSS (tokens, tombol, state, focus) — fondasi semua.
2. Template list seragam + selection + search-match (Status list dulu, lalu Branches/History/Stash/Tags/Remotes).
3. Diff: gutter → word-level → syntax (incremental, tiap langkah punya fallback).
4. Polish per-tab (Sync, Rebase, Tabs/topbar, Toast/modal/empty).
5. Bump versi + README + validasi menyeluruh.
