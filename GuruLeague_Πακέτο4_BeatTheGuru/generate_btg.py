#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
generate_btg.py — Παράγει το btg_data.json για τον μήνα του Beat The Guru.

Χρήση:  python3 generate_btg.py 2026-08 August
Θέλει δίπλα του: db_era.json (το era DB του index — βλ. εξαγωγή παρακάτω),
champ_keys.json, nat_keys.json.

Εξαγωγή db_era.json από το index.html (μία φορά, ή μετά από αλλαγές DB):
  python3 - <<'EOF'
  import re,json
  h=open('index.html',encoding='utf-8').read()
  i=h.find('const DB = ');j=h.find(';\\nconst ERAS',i)
  json.dump(json.loads(h[i+11:j]),open('db_era.json','w'),ensure_ascii=False)
  EOF
"""
import json, sys, re, random, unicodedata

# ---------------- TUNING (τα knobs του μήνα) ----------------
SERB_GURU_RANKS = [1, 3, 5, 8, 10, 12]  # ποιες θέσεις PIR παίρνει ο Σέρβος Guru (μικρότερα = δυσκολότερος)
P3_GURU_PICK    = (1, 3)                # C3: από τον 2ο έως 4ο καλύτερο σουτέρ κάθε pool
C1_NOISE_TOP    = 2                     # C1/C5: διαλέγει τυχαία από τους top-N του pool
SEED            = None                  # βάλε ακέραιο για αναπαραγώγιμους Guru (π.χ. 202608)

GEXCLUDE = {
 "2005-2010":{"AEK Athens","ALBA Berlin","Dynamo Moscow","Brose Bamberg","Lietuvos Rytas"},
 "2010-2015":{"Valencia Basket","Lokomotiv Kuban","Khimki","UNICS","Bayern Munich","Crvena Zvezda"},
 "2015-2020":{"Lokomotiv Kuban","Cedevita","Galatasaray","UNICS","Buducnost","Gran Canaria"},
 "2020-2025":{"Dubai Basketball","Hapoel Tel Aviv","UNICS","Khimki"}}
SERB_ERAS = ["2010-2015","2015-2020","2020-2025"]
STD_SLOTS = ["G","G","F","F","C","ANY"]

def nrm(s):
    s = unicodedata.normalize('NFKD', str(s))
    s = ''.join(c for c in s if not unicodedata.combining(c)).lower()
    return re.sub(r'[^a-z0-9]','', re.sub(r'\b(jr|iii|iv)\b\.?','',s))

def main():
    month = sys.argv[1] if len(sys.argv)>1 else '2026-08'
    label = sys.argv[2] if len(sys.argv)>2 else 'August'
    if SEED is not None: random.seed(SEED)
    DB = json.load(open('db_era.json'))
    champs = set(json.load(open('champ_keys.json')))
    nat = json.load(open('nat_keys.json'))
    ERAS = list(DB.keys())
    natOf = lambda n: nat.get(nrm(n), 'INT')
    isCh  = lambda n: nrm(n) in champs
    def teams(era): return [t for t in DB[era] if t not in GEXCLUDE.get(era, set())]
    def slot_pool(era, t, sl): return [p for p in DB[era][t] if sl in ('ANY','★') or p.get('cpos')==sl]
    def shrunk(p): return (p.get('m3',0)+2)/((p.get('a3',0) or 0)+8)

    MINE = {0: lambda p: isCh(p['name']),
            3: lambda p: natOf(p['name'])!='USA',
            4: lambda p: not isCh(p['name'])}
    VALID = {0: dict(minLegal=4, maxMine=.6), 2: dict(minLegal=4, maxMine=1.0),
             3: dict(minLegal=2, maxMine=1.0), 4: dict(minLegal=3, maxMine=1.0)}

    def draw(ci, sl, taken):
        mine = MINE.get(ci, lambda p: False); v = VALID[ci]; ml = v['minLegal']
        for g in range(400):
            if g==200 and ml>2: ml -= 1
            era = random.choice(ERAS); t = random.choice(teams(era))
            pool = slot_pool(era, t, sl)
            legal = [p for p in pool if not mine(p) and nrm(p['name']) not in taken]
            mines = sum(1 for p in pool if mine(p))
            if len(pool)>=5 and len(legal)>=ml and mines/len(pool)<=v['maxMine']:
                return era, t, legal
        raise RuntimeError(f'no valid spin C{ci+1} {sl}')

    def slim(p, era, t):
        return {k:p.get(k) for k in ('name','pos','cpos','gp','ppg','rpg','apg','spg','bpg','tpg','efg','value')} | \
               {'m3':p.get('m3',0),'a3':p.get('a3',0),'era':era,'team':t}

    def build(ci, key):
        taken, six = set(), []
        for sl in STD_SLOTS:
            era, t, legal = draw(ci, sl, taken)
            if key=='p3':
                legal.sort(key=shrunk, reverse=True)
                pick = random.choice(legal[P3_GURU_PICK[0]:P3_GURU_PICK[1]+1] or legal[:1])
            elif key=='greedy':
                pick = max(legal, key=lambda p: p.get('value') or 0)
            else:
                legal.sort(key=lambda p: -(p.get('value') or 0))
                pick = random.choice(legal[:C1_NOISE_TOP])
            taken.add(nrm(pick['name'])); six.append(slim(pick, era, t))
        return six

    def serb_guru(era):
        best = {}
        for t, ps in DB[era].items():
            for p in ps:
                k = nrm(p['name'])
                if k not in best or (p.get('value') or 0) > (best[k][0].get('value') or 0): best[k] = (p, t)
        srb = sorted([(p,t) for (p,t) in best.values() if natOf(p['name'])=='SRB'],
                     key=lambda x: -(x[0].get('value') or 0))
        return [slim(*srb[min(i, len(srb)-1)], ) if False else slim(srb[min(i,len(srb)-1)][0], era, srb[min(i,len(srb)-1)][1]) for i in SERB_GURU_RANKS]

    gurus = {'c0': build(0,'noise'), 'c2': build(2,'p3'), 'c3': build(3,'greedy'), 'c4': build(4,'noise'),
             'c1': {e: serb_guru(e) for e in SERB_ERAS}}
    out = {'month': month, 'label': label, 'champs': sorted(champs), 'nat': nat, 'gurus': gurus}
    json.dump(out, open('btg_data.json','w'), ensure_ascii=False, separators=(',',':'))
    # αναφορά
    p3team = 100*sum(p['m3'] for p in gurus['c2'])/max(1,sum(p['a3'] for p in gurus['c2']))
    print(f"btg_data.json για {label} ({month})")
    print('C1:', ', '.join(p['name'] for p in gurus['c0']))
    for e in SERB_ERAS: print(f'C2 {e}:', ', '.join(p['name'] for p in gurus['c1'][e]))
    print(f"C3 (team 3P% {p3team:.1f}):", ', '.join(p['name'] for p in gurus['c2']))
    print('C4:', ', '.join(p['name'] for p in gurus['c3']), '| όλοι USA:', all(natOf(p['name'])=='USA' for p in gurus['c3']))
    print('C5:', ', '.join(p['name'] for p in gurus['c4']), '| όλοι champs:', all(isCh(p['name']) for p in gurus['c4']))
    if not (35 <= p3team <= 41): print('⚠ C3 Guru εκτός στόχου 35-41% — ξανατρέξε ή πείραξε P3_GURU_PICK')

if __name__ == '__main__':
    main()
