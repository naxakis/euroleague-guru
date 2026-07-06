# GuruLeague — ΠΑΚΕΤΟ 4: BEAT THE GURU στο production (v24)
*(06/07/2026 · πρώτος επίσημος μήνας: Ιούλιος 2026)*

## Αρχιτεκτονική με μια ματιά
Το Beat The Guru μπαίνει ως ΑΥΤΟΝΟΜΟ module (`btg.html`) που φορτώνει σε iframe μέσα
σε νέο screen του index. Γιατί iframe: μηδέν συγκρούσεις CSS/JS/ids με το κυρίως app
(υπάρχουν ήδη ids `val-era`, `slot-era`, `toast` που θα συγκρούονταν), το diff του
index μένει μικροσκοπικό, και λόγω ίδιου origin το module μοιράζεται το `DB` του
index (window.parent.DB) και το ίδιο localStorage/guruToken. Οι Guru είναι ΚΟΙΝΟΙ για
όλους ανά μήνα (προϋπολογισμένοι στο btg_data.json)· τα spins είναι τυχαία ανά παίκτη.

## Αρχεία → πού πάνε (όλα στο root του repo εκτός αν λέει αλλιώς)
1. `index_v24_beat_the_guru.html` → αντικαθιστά το `index.html`. Περιέχει:
   - Όλα τα v22 (spin easing, SEO, gp-guard) + το v23 DB (σεζόν 2025-26,
     στρογγυλοποιήσεις, πεδία m3/a3 για 3P% — το υπόλοιπο app τα αγνοεί ακίνδυνα).
   - Νέα κάρτα "Beat The Guru · NEW" στο home (μετά το Leagues).
   - Νέο `screen-btg` (κουμπί HOME + iframe, lazy: το btg.html φορτώνει στο 1ο άνοιγμα).
2. `btg.html` → ΝΕΟ. Όλο το module (27KB): χάρτης 5 challenges, draft, νάρκες/strikes,
   reveal, scoring (7 κατηγορίες / team 3P%), πάνθεον. Διαβάζει DB από το parent και
   `btg_data.json` από το root. Αν το /api/btg λείπει, παίζει ΠΛΗΡΩΣ offline
   (πρόοδος τοπικά) — άρα δουλεύει και σε preview πριν στηθεί το backend.
3. `btg_data.json` → ΝΕΟ. Ο Ιούλιος: challenges data (πρωταθλητές, εθνικότητες) +
   οι 5 κοινοί Guru του μήνα.
4. `api_btg.js` → μετονομασία σε **`api/btg.js`**. Ίδιο στυλ/env με το tournament.js
   (Upstash REST, zero deps). Ένα hash ανά μήνα `btg:<YYYY-MM>`, ένα record ανά
   guruToken. Routes: GET ?token → {me, pantheon, players} · POST sync (με monotonic
   guards: ήττες/strikes μόνο αυξάνονται, νίκες μόνο κλειδώνουν) · POST reset (ADMIN_KEY).
   Δεν θέλει καμία νέα env μεταβλητή.
5. `generate_btg.py` + `db_era.json`, `champ_keys.json`, `nat_keys.json` → εργαλείο
   μήνα (κρατήστε τα όπου βολεύει, δεν χρειάζονται στο deploy — μόνο το json που παράγουν).

## Αλλαγή μήνα (π.χ. 1η Αυγούστου) — 1 λεπτό
```
python3 generate_btg.py 2026-08 August   # βγάζει νέο btg_data.json + αναφορά ποιότητας
git commit btg_data.json && push          # τέλος
```
Ο client διαβάζει το month από το JSON: νέος μήνας = νέο τοπικό progress, νέο hash στο
API, νέο πάνθεον. Τα challenges/κανόνες μένουν ίδια τον 1ο κύκλο· νέα θέματα Αυγούστου
= επόμενη δουλειά μαζί με τον Claude (τα configs ζουν στο btg.html, ενότητα CH).
Tuning δυσκολίας: σταθερές στην κορυφή του generate_btg.py (SERB_GURU_RANKS,
P3_GURU_PICK, C1_NOISE_TOP) — ξανατρέχεις, ξανακάνεις commit.

## Οι 5 Guru του Ιουλίου (για τα μάτια σας μόνο 🤫)
C1 No Champions: Roberts/Dallo/Bolden/Mirotic/Oturu/Jackson ·
C2 Serbian Steel: ανά era (π.χ. 2020-25: Milutinov, Lucic, Kalinic, Mitrovic, Avramović, Davidovac) ·
C3 Splash Zone: team 39.2% · C4 American Dream: σκληρός greedy (Wolters/Rice/Evans/Clyburn/Hunter/Jones) ·
C5 Champions Only: Papaloukas/Causeur/Clyburn/Kurbanov/Lessort/Micic.

## Rollout
branch `v24-beat-the-guru` → commit τα 1-4 → Vercel preview → δοκιμή (το BTG παίζει
και χωρίς backend· με το api/btg.js ανεβασμένο δουλεύει και το πάνθεον) → merge
("Create a merge commit", όχι squash). Το NEW badge στην κάρτα το κατεβάζετε όποτε
θέλετε (index, string "NEW").

## Γνωστά όρια v1 (συνειδητές αποφάσεις)
- Πρόοδος ανά συσκευή (guruToken) — sync code κινητό↔laptop: μελλοντικό.
- Client-trusted σκορ όπως όλο το site· τα monotonic guards κόβουν τα τετριμμένα.
- PIR=0 στους rookies 2025-26 (δεν υπήρχε στην πηγή) — αφορά μόνο επιλογές Guru, όχι scoring.
