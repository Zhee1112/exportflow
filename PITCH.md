# Naskah Video Pitch — ExportFlow (3–5 menit)

Format rekomendasi: **demo live ~7 menit direkam, dipotong jadi 4 menit** (aturan
challenge: video 3–5 menit). Siapkan satu cadangan rekaman penuh kalau live demo
terganggu (wallet connect, RPC lambat).

Rekaman layar + suara. Jangan tampilkan seed phrase, private key, atau `.env.local`.

---

## Hook (0:00–0:20)

> "UMKM eksportir Indonesia menahan modal kerja berbulan-bulan, sementara pembeli
> asing takut dana hilang sebelum barang datang. ExportFlow mengunci pembayaran
> dalam stablecoin per milestone di QDay Aevum — dan AI agent membaca PO-nya,
> dengan izin yang dibatasi kontrak, bukan janji."

Tampilkan: header ExportFlow + halaman Trade yang sudah terisi.

## Masalah & angka (0:20–0:50)

> "Kesenjangan pembiayaan UMKM Rp2.400 triliun; 69,5% UMKM tanpa akses kredit
> bank (detik/FYB). Perdagangan global kehilangan sekitar US$2,5 triliun
> pembiayaan (ADB 2025). Yang kurang bukan niat, tapi jaminan dan kepercayaan."

Cukup 2–3 kalimat — detail ada di R&D doc.

## Demo inti (0:50–3:00) — alur Escrow

1. **Create** (Trade page): tambah 2 milestone, klik Create → tx muncul.
2. **Fund gasless**: klik Fund → tanda tangan EIP-3009 sekali, tanpa tQDAY.
   Sebut: *"relayer yang bayar gas, on-chain tx-nya bisa dicek di explorer."*
3. **Seller agent bukti**: klik "File proof" → `submitEvidence` dari server key.
   Sebut: *"jendela 600 detik — kalau pembeli diam, penjual boleh klaim; kalau
   keberatan, naikkan sengketa."*
4. **Approve milestone** → dana cair ke penjual. Tunjukkan saldo penjual bertambah.
5. *(Opsional, jika waktu)* Sengketa singkat: Raise dispute → arbiter split.

Setiap langkah tunjukkan tx hash di layar (Activity page atau explorer).

## AI document agent (3:00–3:45)

1. Buka PO Reader → "Load PO with injection" → Read.
2. Tunjukkan **peringatan injection** muncul: *"dokumen diperlakukan sebagai data,
   bukan instruksi — pola 'kirim uang sekarang', 'lewati persetujuan' ditandai
   sebelum agen boleh memakainya."*
3. Sebut hash di-anchored ke DocRegistry on-chain — dasar anti pembiayaan ganda.

## Session keys (3:45–4:15)

> "Aevum belum punya bundler resmi, jadi kami bikin SessionPolicy di kontrak:
> kunci sesi browser cuma boleh panggil fungsi tertentu, dengan batas nominal dan
> masa berlaku."

Demo cepat: Grant → agent coba spend melebihi cap → **revert** → Revoke.
Tunjukkan error "over cap" dan "unlisted call" yang ditolak kontrak.

## Bukti on-chain & teknis (4:15–4:40)

> "Tiga kontrak ter-deploy di Aevum testnet: Escrow, SessionPolicy, DocRegistry.
> 51 tes unit + 3 tes fork lulus. E2E create → fund gasless → cair terekam penuh —
> tx hashes ada di README."

Tampilkan tabel kontrak dari README sebentar.

## Penutup (4:40–5:00)

> "Escrow milestone murah gas (claim ~47k), aman (CEI + nonReentrant + total
> dihitung kontrak), dan AI-nya berizin kontrak. Advance pool, reputasi, dan
> marketplace ada di roadmap. Testnet saja — token uji, tanpa penerbitan token.
> Repo: github.com/Zhee1112/exportflow. Terima kasih."

---

## Checklist sebelum rekam

- [ ] `pnpm dev` jalan, wallet terkoneksi ke Aevum testnet (chain 44005)
- [ ] Saldo tQDAY + tUSD8 cukup (faucet Discord `/faucet`)
- [ ] `.env.local` terisi (alamat kontrak, `RELAYER_PRIVATE_KEY`, `RINA_PRIVATE_KEY`)
- [ ] Activity page sudah menampilkan event terbaru (deploy block 3920736)
- [ ] Tab explorer terbuka: https://explorer-test.qday.info
- [ ] Rekaman cadangan penuh dijalankan sekali (jika live gagal)
- [ ] Durasi final 3–5 menit (potong bagian menunggu tx)
