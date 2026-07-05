# GuruLeague — Spec: GAUNTLET MODE v1
*(συμφωνήθηκε 05/07/2026 — για συζήτηση/υλοποίηση με [φίλος]· τα ανοιχτά θέματα στο τέλος)*

## 1. Concept σε μία παράγραφο
Μηνιαία σειρά 5 επιμελημένων challenges («gauntlet»). Σε καθένα χτίζεις 6άδα με
θεματικούς περιορισμούς και **κρυφά στατιστικά**, και παίζεις H2H κόντρα στον
**Guru** (bot-ομάδα) με το υπάρχον category engine. Νίκη → ξεκλειδώνει το επόμενο.
Ήττα → μετράει για πάντα, ξαναπροσπαθείς αμέσως (σκορ γκολφ: λιγότερες ήττες = καλύτερος).
Όποιος περάσει και τα 5 μπαίνει στο πάνθεον του μήνα (π.χ. **JULY GURUS**),
με tiers ανάλογα με τις ήττες. Την 1η του μήνα: νέα 5 challenges, νέο πάνθεον.

## 2. Ροή παίκτη
1. Home → κάρτα «GAUNTLET — July» με πρόοδο (π.χ. ●●○○○).
2. Challenge intro: θέμα + κανόνες της μέρας (π.χ. «Ringless: 6άδα ΧΩΡΙΣ κούπα EL — προσοχή στις νάρκες!»).
3. Draft 6 γύρων όπως το υπάρχον: spin era → spin ομάδα → pool → επιλογή.
   - Pool: **αλφαβητικά, χωρίς στατιστικά** (hidden mode). Ορατά: όνομα, θέση, ομάδα, era.
   - Ορατοί περιορισμοί (θέση/era ανά slot) φιλτράρονται σιωπηλά — δεν είναι παγίδες.
   - Κρυφοί περιορισμοί (κούπα/NBA/εθνικότητα, ανάλογα το challenge) = **νάρκες**:
     πατάς λάθος παίκτη → «🏆 Έχει πάρει!» → +1 strike, η κάρτα γκριζάρει.
   - **3ο strike = bust**: η προσπάθεια τελειώνει, μετράει ήττα. (strikes: παράμετρος ανά challenge)
4. Ολοκλήρωση 6άδας → flip reveal στατιστικών → H2H με Guru (pairWinner).
5. Νίκη → challenge ΚΛΕΙΔΩΝΕΤΑΙ (δεν ξαναπαίζεται) → επόμενο διαθέσιμο.
   Ήττα → +1 ήττα στο μητρώο, κουμπί «Retry» ΑΜΕΣΑ (χωρίς cooldown).
6. Παράλληλα η 6άδα μπαίνει στο ladder του challenge (ο Guru εμφανίζεται μέσα ως 🧙).

## 3. Κανόνες σκορ & κατάταξης
- **Μονάδα σκορ: η ήττα** (από Guru, ή bust). Αθροίζεται σε όλο το gauntlet, δεν σβήνει ποτέ.
- Retry: απεριόριστα, άμεσα. ΚΑΘΕ retry κληρώνει νέα spins: `seed(month, challengeId, attemptNo)`
  → νέα eras/ομάδες/pools ανά προσπάθεια (ακυρώνει memorization/brute force).
- Πάνθεον μήνα (π.χ. JULY GURUS): όσοι νίκησαν και τα 5.
  Tiers: **FLAWLESS GURU** (0 ήττες) / **GURU** (ολοκλήρωση).
  Κατάταξη εντός: ήττες ↑ → συνολικά strikes ↑ → χρόνος ολοκλήρωσης ↑ (νωρίτερα = καλύτερα).
- Challenge 5 = «Final Boss»: δυνατότερος Guru, ενδεχομένως 2 strikes.

## 4. Ο Guru (bot)
- Χτίζεται ντετερμινιστικά ανά challenge: greedy επιλογή με seeded «ατέλεια»
  ώστε καλός παίκτης να τον νικά ~40-50% (νικήσιμος, όχι χάρισμα). Tuning μετά από δοκιμές.
- Ίδιος για όλους, όλο τον μήνα. Στο ladder ως συμμετοχή «The Guru 🧙».

## 5. Ταυτότητα & όρια (χωρίς login)
- Ταυτότητα: υπάρχον `guruToken()` (localStorage). Όνομα = display μόνο.
- Server-side ανά token: πρόοδος gauntlet, ήττες, strikes, timestamps, κλειδωμένες νίκες.
- Ένα gauntlet run ανά token ανά μήνα. Καθάρισμα token = χαμένη πρόοδος (αυτοτιμωρία cheat).
- Μελλοντικό nice-to-have: sync code 6 χαρακτήρων για κινητό↔laptop (όχι v1).

## 6. Δεδομένα που απαιτούνται (τα 2 πρώτα ΕΤΟΙΜΑ)
- `nat` ανά παίκτη → nat_map.json (παραδόθηκε) + continent (παράγωγο).
- `champ` (κούπα EL) → champions_list.json: υπολογισμένο από ρόστερ πρωταθλητών 2005-25
  + χειροκίνητο patch προ-2005 (12 παίκτες). 179/1274 πρωταθλητές.
- `nba` (≥1 επίσημο NBA RS παιχνίδι) → ΕΚΚΡΕΜΕΙ χειρωνακτικό πέρασμα (όπως εθνικότητες).
- Μηνιαία challenges: ΕΠΙΜΕΛΗΜΕΝΑ (όχι γεννήτρια) σε `gauntlet_<month>.json`:
  θέμα, περιορισμοί ανά slot, τύπος νάρκας, strikes, Guru config. Commit στο repo, μηδέν αλλαγή κώδικα.
  (Η seed-γεννήτρια κρατιέται για το μελλοντικό Daily Challenge — layer πάνω στο ίδιο σύστημα.)

## 7. Υλοποίηση — τι υπάρχει ήδη / τι χτίζεται
ΥΠΑΡΧΕΙ: spin (v22 με επιβράδυνση), draft flow, pairWinner, ladders API pattern,
seededRand, guruToken, admin screen.
ΧΤΙΖΕΤΑΙ: screen-gauntlet (intro/progress/pantheon), hidden-mode στο pool render
(απόκρυψη stats + αλφαβητική σειρά + strike handling), flip reveal, Guru builder,
API namespace `gauntlet:*` (progress ανά token, ladder ανά challenge, pantheon ανά μήνα).

## 8. Ιδέες θεμάτων (backlog — 1 μήνας = διάλεξε 5)
Εθνικότητα (Spanish Armada / Greek Freaks / Serbian Steel) · Ringless 🚫🏆 ·
Champions Only · Never-NBA / NBA Alumni · Budget draft (cap σε PIR) ·
Franchise lock (6 παίκτες, 6 franchises) · Underdogs (<10 PPG) · Teammates Of X ·
Σπάνια specials: Rest of the World, Latin America, Lefty Day (curated λίστες).

## 9. Ανοιχτά θέματα προς απόφαση
1. eFG% ως 7η κατηγορία στο pairWinner (εκκρεμεί από πριν — προσοχή: αναδρομικό effect στα υπάρχοντα ladders).
2. Strikes default: 3 (πρόταση) — επιβεβαίωση μετά από playtesting.
3. Ονοματολογία tiers/πάνθεον & πόσοι μήνες ιστορικό κρατιέται.
4. Τι βλέπει όποιος ΔΕΝ έχει περάσει το προηγούμενο challenge: κλειδωμένη κάρτα με teaser (πρόταση) ή κρυφό;
5. NBA πεδίο: ξεκινάει το χειρωνακτικό πέρασμα; (χρειάζεται μόνο αν μπει NBA-θέμα στον πρώτο μήνα)
