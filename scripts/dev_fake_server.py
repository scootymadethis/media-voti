"""Aulera in locale con un ClasseViva FINTO (dati di esempio realistici, nessuna rete).

Serve per sviluppare e provare l'interfaccia senza un account reale:

    .venv/bin/python scripts/dev_fake_server.py            # http://127.0.0.1:8000
    PORT=8011 .venv/bin/python scripts/dev_fake_server.py

Per entrare: pagina di login -> "Sviluppo: accedi con un cookie" -> qualsiasi valore di
almeno 16 caratteri (es. devsession000000001). Un valore che inizia con "devfriend"
(es. devfriend00000001) entra come un secondo studente della stessa classe, per provare gli amici.
Il DB è temporaneo (/tmp).
"""
from __future__ import annotations

import json
import os
import random
import re
import sys
import tempfile
from datetime import date, datetime, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
PORT = int(os.getenv("PORT", "8000"))
os.environ.setdefault("DATABASE_PATH", os.path.join(tempfile.mkdtemp(prefix="aulera-dev-"), "dev.db"))
os.environ.setdefault("DEV_MODE", "true")
os.environ.setdefault("COOKIE_SECURE", "false")
os.environ.setdefault("ALLOW_MANUAL_WEB_SESSION_LOGIN", "true")
os.environ.setdefault("ALLOWED_ORIGINS", f"http://127.0.0.1:{PORT}")
os.environ.setdefault("ADMIN_USERNAME", "S7654321X")

import requests  # noqa: E402

import classeviva_client as cv  # noqa: E402

STUDENT_ID = "7654321"
OTHER_ID = "1000001"  # secondo studente, stessa classe
TODAY = date.today()
rng = random.Random(42)

SUBJECTS = [
    ("MATEMATICA", "ROSSI ANNA"),
    ("LINGUA E LETTERATURA ITALIANA", "BIANCHI MARCO"),
    ("LINGUA INGLESE", "SMITH JANE"),
    ("STORIA", "BIANCHI MARCO"),
    ("SISTEMI E RETI", "VERDI LUCA"),
    ("INFORMATICA", "NERI PAOLA"),
    ("TECNOLOGIE E PROGETTAZIONE DI SISTEMI INFORMATICI", "VERDI LUCA"),
    ("SCIENZE MOTORIE E SPORTIVE", "GALLI SARA"),
    ("RELIGIONE CATTOLICA", "FERRARI DON PIETRO"),
]


def d(days: int) -> date:
    return TODAY + timedelta(days=days)


def school_day(offset: int) -> date:
    day = d(offset)
    while day.weekday() >= 5:
        day -= timedelta(days=1)
    return day


def build_grades():
    grades = []
    evt = 1000
    for idx, (subject, teacher) in enumerate(SUBJECTS):
        base = rng.uniform(5.6, 8.8)
        for n in range(rng.randint(3, 6)):
            value = max(3.0, min(10.0, round((base + rng.uniform(-1.6, 1.4)) * 4) / 4))
            when = school_day(-n * 9 - idx)
            display = str(int(value)) if value == int(value) else (
                f"{int(value)}+" if value - int(value) == 0.25 else
                f"{int(value)}½" if value - int(value) == 0.5 else f"{int(value) + 1}-"
            )
            comp = rng.choice([(1, "Scritto"), (2, "Orale"), (3, "Pratico")])
            evt += 1
            grades.append({
                "subjectId": 100 + idx, "subjectCode": "", "subjectDesc": subject,
                "evtId": evt, "evtCode": "GRV0", "evtDate": when.isoformat(),
                "decimalValue": value, "displayValue": display, "displaPos": 1,
                "notesForFamily": rng.choice(["", "", "Verifica sulle funzioni", "Interrogazione", "Esposizione chiara"]),
                "color": "green" if value >= 6 else "red", "canceled": False, "underlined": False,
                "periodPos": 1, "periodDesc": "Primo Periodo", "periodLabel": "Trimestre",
                "componentPos": comp[0], "componentDesc": comp[1], "weightFactor": 100,
                "skillId": 0, "gradeMasterId": 0, "teacherName": teacher, "noAverage": False,
            })
    grades.append({**grades[0], "evtId": 999, "decimalValue": None, "displayValue": "ds",
                   "noAverage": True, "color": "blue", "notesForFamily": "Giustificato"})
    return grades


def build_absences():
    events = []
    for i, (code, offset, value) in enumerate([
        ("ABA0", -3, None), ("ABR0", -10, 1), ("ABU0", -16, 2), ("ABA0", -24, None),
        ("ABR1", -30, 1), ("ABA0", -41, None), ("ABA0", -42, None),
    ]):
        events.append({
            "evtId": 5000 + i, "evtCode": code, "evtDate": school_day(offset).isoformat(),
            "evtHPos": 2 if code != "ABA0" else None, "evtValue": value,
            "isJustified": i > 1, "justifReasonCode": "A" if i > 1 else "", "justifReasonDesc": "Motivi di salute" if i > 1 else "",
            "hoursAbsence": [], "webJustifStatus": 0,
        })
    return events


def build_agenda(start: date, end: date):
    items = []
    day = start
    i = 0
    while day <= end:
        if day.weekday() < 5 and (day.toordinal() % 2 == 0):
            subj, teacher = SUBJECTS[day.toordinal() % 7]
            kind = "AGHW" if day.toordinal() % 3 else "AGNT"
            text = (f"Esercizi pag. {100 + day.day} n. 1-{5 + day.day % 6}" if kind == "AGHW"
                    else rng.choice(["Verifica scritta", "Interrogazione programmata", "Uscita didattica al museo"]))
            items.append({
                "evtId": 7000 + i, "evtCode": kind,
                "evtDatetimeBegin": f"{day.isoformat()}T08:00:00+01:00", "evtDatetimeEnd": f"{day.isoformat()}T09:00:00+01:00",
                "isFullDay": False, "notes": text, "authorName": teacher, "classDesc": "5EI INFORMATICA",
                "subjectId": 100 + day.toordinal() % 7, "subjectDesc": subj, "homeworkId": None,
            })
            i += 1
        day += timedelta(days=1)
    return items


def build_lessons(day: date):
    if day.weekday() >= 5:
        return []
    out = []
    # Giornate di lunghezza diversa (come un orario vero): lun 6, mar 7, mer 6, gio 5, ven 6 ore.
    for h in range(1, (6, 7, 6, 5, 6)[day.weekday()] + 1):
        subj, teacher = SUBJECTS[(day.toordinal() + h) % 8]
        out.append({
            "evtId": 9000 + h, "evtDate": day.isoformat(), "evtCode": "LSF0", "evtHPos": h, "evtDuration": 1,
            "classDesc": "5EI INFORMATICA", "authorName": teacher, "subjectId": 100, "subjectCode": None,
            "subjectDesc": subj, "lessonType": "Lezione",
            "lessonArg": rng.choice(["Derivate e studio di funzione", "Il Novecento: Pirandello", "Subnetting IPv4",
                                     "Present perfect continuous", "Database relazionali: JOIN", ""]),
        })
    return out


NOTICEBOARD = [
    {"pubId": 555 + i, "pubDT": f"{d(-i * 3).isoformat()}T10:2{i}:00+01:00", "readStatus": i > 2, "evtCode": "CF",
     "cntId": 9000 + i, "cntValidFrom": d(-i * 3).isoformat(), "cntValidTo": d(60).isoformat(), "cntValidInRange": True,
     "cntStatus": "active", "cntTitle": title, "cntCategory": cat, "cntHasChanged": False,
     "cntHasAttach": True, "needJoin": False, "needReply": False, "needFile": False, "needSign": i == 1,
     "evento_id": str(i), "attachments": [{"fileName": f"{title}.pdf", "attachNum": 1}]}
    for i, (title, cat) in enumerate([
        ("Circolare n. 112 - Assemblea di istituto", "Circolare"),
        ("Uscita didattica classi quinte", "Comunicazione"),
        ("Calendario colloqui generali", "Circolare"),
        ("Sciopero del comparto scuola", "Avviso"),
        ("Orientamento in uscita: open day universitari", "Comunicazione"),
        ("Progetto certificazioni linguistiche", "Circolare"),
    ])
]

DIDACTICS = [
    {"teacherId": "A100", "teacherName": "ROSSI ANNA", "teacherFirstName": "ANNA", "teacherLastName": "ROSSI",
     "folders": [{"folderId": 1, "folderName": "Analisi", "lastShareDT": f"{d(-2).isoformat()}T09:00:00+01:00", "contents": [
         {"contentId": 48713001, "contentName": "Esercizi sulle derivate", "objectId": 1, "objectType": "file", "shareDT": f"{d(-2).isoformat()}T09:00:00+01:00"},
         {"contentId": 48713002, "contentName": "Video: limiti notevoli", "objectId": 2, "objectType": "link", "shareDT": f"{d(-9).isoformat()}T09:00:00+01:00"},
     ]}]},
    {"teacherId": "A200", "teacherName": "VERDI LUCA", "teacherFirstName": "LUCA", "teacherLastName": "VERDI",
     "folders": [{"folderId": 2, "folderName": "Reti", "lastShareDT": f"{d(-5).isoformat()}T09:00:00+01:00", "contents": [
         {"contentId": 48713003, "contentName": "Slide subnetting", "objectId": 3, "objectType": "file", "shareDT": f"{d(-5).isoformat()}T09:00:00+01:00"},
         {"contentId": 48713004, "contentName": "Consegna progetto", "objectId": 4, "objectType": "text", "shareDT": f"{d(-12).isoformat()}T09:00:00+01:00"},
     ]}, {"folderId": 3, "folderName": "Laboratorio", "lastShareDT": f"{d(-20).isoformat()}T09:00:00+01:00", "contents": [
         {"contentId": 48713005, "contentName": "Packet Tracer - esercitazione 3", "objectId": 5, "objectType": "file", "shareDT": f"{d(-20).isoformat()}T09:00:00+01:00"},
     ]}]},
]

NOTES = {
    "NTTE": [{"evtId": 17119297, "evtText": "Non ha portato il materiale di laboratorio.", "evtDate": d(-6).isoformat(), "authorName": "VERDI LUCA", "readStatus": False}],
    "NTCL": [],
    "NTWN": [{"evtId": 17119298, "evtText": "Compiti non svolti.", "evtDate": d(-15).isoformat(), "authorName": "ROSSI ANNA", "readStatus": True, "warningType": "Compiti"}],
    "NTST": [],
}

HOMEWORKS = [
    {"evtId": 3100 + i, "evtCode": "NEWDC", "teacherId": 1, "teacherName": t, "homeworkDesc": desc,
     "homeworkDone": False, "homeworkMarkedDone": i == 2, "assignmentDate": d(-i * 2 - 1).isoformat(), "assignmentTime": "09:00",
     "expiryDate": d(i * 2 + 1).isoformat(), "expiryTime": "23:59", "studentAttachmentsAllowed": True,
     "subjectId": 100, "subjectDesc": s, "teacherFiles": [{"fileId": 1, "fileName": "traccia.pdf"}] if i == 0 else [],
     "teacherLinks": [], "studentFiles": [], "correctedFiles": [], "newMessages": 0}
    for i, (s, t, desc) in enumerate([
        ("INFORMATICA", "NERI PAOLA", "Progettare lo schema ER della biblioteca"),
        ("LINGUA INGLESE", "SMITH JANE", "Essay: technology and privacy (250 words)"),
        ("STORIA", "BIANCHI MARCO", "Riassunto capitolo 4"),
    ])
]

BOOKS = [{"courseId": 1, "courseDesc": "5EI INFORMATICA", "books": [
    {"bookId": 96679 + i, "isbnCode": f"97888089377{30 + i}", "title": title, "subheading": None, "volume": "U",
     "author": author, "publisher": pub, "subjectDesc": subj, "price": price, "toBuy": i % 2 == 0, "newAdoption": i == 1,
     "alreadyOwned": False, "alreadyInUse": i % 2 == 1, "recommended": False, "recommendedFor": None, "coverUrl": None,
     "publisherUnlockCode": ""}
    for i, (title, author, pub, subj, price) in enumerate([
        ("Matematica.verde 5", "Bergamini, Barozzi", "Zanichelli", "MATEMATICA", 34.9),
        ("Il rosso e il blu 3", "Giunta", "Garzanti Scuola", "LINGUA E LETTERATURA ITALIANA", 41.5),
        ("Performer B2", "Spiazzi, Tavella", "Zanichelli", "LINGUA INGLESE", 29.8),
        ("Sistemi e reti 3", "Lo Russo, Bianchi", "Hoepli", "SISTEMI E RETI", 27.9),
    ])]}]

DOCUMENTS = {"documents": [{"hash": "ad6192418c134c453948d254739167f5", "desc": "Patto di corresponsabilità"}],
             "schoolReports": [{"desc": "Pagella (Web) Primo Periodo", "confirmLink": "https://web.spaggiari.eu/", "viewLink": "https://web.spaggiari.eu/"}]}


def calendar_days():
    out = []
    start = date(TODAY.year if TODAY.month >= 9 else TODAY.year - 1, 9, 10)
    for i in range(280):
        day = start + timedelta(days=i)
        status = "NW" if day.weekday() == 6 else ("HD" if (day.month == 12 and 23 <= day.day) or (day.month == 1 and day.day <= 6) else "SD")
        out.append({"dayDate": day.isoformat(), "dayOfWeek": day.isoweekday(), "dayStatus": status})
    return out


ORARIO_CLASSES = ["5EI", "5EL", "4EI", "3EI", "ALT"]


def orario_entries():
    rows = []
    for day in range(1, 6):
        for hour in range(1, 7 if day != 3 else 6):
            subj = SUBJECTS[(day * 3 + hour) % 8][0].split(" ")[0][:10]
            rows.append({"giorno": day, "ora": hour, "materia": subj, "aula": f"L{(day + hour) % 4 + 1}"})
    return rows


class R:
    def __init__(self, status, payload=None, ctype="application/json", body=b"", headers=None):
        self.status_code = status
        self._payload = payload
        self.headers = {"Content-Type": ctype, **(headers or {})}
        self.text = json.dumps(payload) if payload is not None else ""
        self.body = body

    def json(self):
        if self._payload is None:
            raise ValueError("no json")
        return self._payload

    def iter_content(self, chunk_size=1):
        yield self.body

    def close(self):
        pass


PDF = b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/MediaBox[0 0 300 144]/Parent 2 0 R>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF"


def fake(method: str, url: str, headers=None, **kw):
    method = method.upper()
    if url.startswith("https://api.marconivr.it/orario"):
        params = kw.get("params") or {}
        if params.get("class"):
            return R(200, orario_entries())
        return R(200, {"classes": ORARIO_CLASSES})
    if url.startswith("https://cdndoc.spaggiari.eu/"):
        return R(200, None, "application/pdf", PDF, {"Content-Disposition": 'attachment; filename="documento.pdf"'})
    if not (headers or {}).get("Cookie", "").startswith("PHPSESSID="):
        return R(302, None, "text/html")
    # Secondo studente (per provare gli amici): cookie che iniziano con "devfriend".
    other = (headers or {}).get("Cookie", "").startswith("PHPSESSID=devfriend")
    sid, first, last = (OTHER_ID, "Marco", "Bellini") if other else (STUDENT_ID, "Giulia", "Conti")
    base = f"/rest/w1/students/{sid}"
    path = url.split("web.spaggiari.eu", 1)[-1].split("?", 1)[0]
    if path == "/rest/w1/misc/whoami":
        return R(200, {"id": f"S{sid}", "nome": first, "cognome": last, "account_type": "S"})
    if not path.startswith(base):
        return R(404, {"error": "not found"})
    p = path[len(base):]
    if p == "/card":
        return R(200, {"card": {"ident": f"S{sid}X", "usrId": int(sid), "usrType": "S", "firstName": first.upper(),
                                "lastName": last.upper(), "birthDate": "2008-03-14", "fiscalCode": "XXXXXX08C54L781X",
                                "schCode": "VRIT0007", "schName": "ISTITUTO TECNICO", "schDedication": "G. MARCONI",
                                "schCity": "VERONA", "schProv": "VR", "miurSchoolCode": "VRTF03000V", "miurDivisionCode": "VRTF03000V"}})
    if p == "/grades":
        return R(200, {"grades": build_grades()})
    if p.startswith("/absences/details"):
        return R(200, {"events": build_absences()})
    m = re.match(r"^/agenda/all/(\d{8})/(\d{8})$", p)
    if m:
        s, e = (datetime.strptime(x, "%Y%m%d").date() for x in m.groups())
        return R(200, {"agenda": build_agenda(s, e)})
    m = re.match(r"^/lessons/(\d{8})(?:/(\d{8}))?$", p)
    if m:
        s = datetime.strptime(m.group(1), "%Y%m%d").date()
        e = datetime.strptime(m.group(2), "%Y%m%d").date() if m.group(2) else s
        out = []
        while s <= e:
            out += build_lessons(s)
            s += timedelta(days=1)
        return R(200, {"lessons": out})
    if p == "/noticeboard":
        return R(200, {"items": NOTICEBOARD})
    m = re.match(r"^/noticeboard/read/CF/(\d+)/101$", p)
    if m:
        item = next((n for n in NOTICEBOARD if str(n["pubId"]) == m.group(1)), None)
        if item:
            item["readStatus"] = True
        return R(200, {"item": {"title": item["cntTitle"] if item else "", "text": "Si comunica che la presente circolare è pubblicata in allegato.\nSi prega di prenderne visione."},
                       "reply": {"replJoin": False, "replText": None, "replFile": None, "replSign": None}})
    if re.match(r"^/noticeboard/attach/CF/\d+/\d+$", p):
        return R(302, None, "text/html", headers={"Location": "https://cdndoc.spaggiari.eu/x/file.pdf?AUTH=dev"})
    if p == "/didactics":
        return R(200, {"didacticts": DIDACTICS})
    m = re.match(r"^/didactics/item/(\d+)$", p)
    if m:
        cid = m.group(1)
        if cid == "48713002":
            return R(200, {"item": {"link": "https://www.youtube.com/"}})
        if cid == "48713004":
            return R(200, {"item": {"text": "Consegnare il progetto entro venerdì.\nFormato: PDF + sorgenti zip."}})
        return R(302, None, "text/html", headers={"Location": "https://cdndoc.spaggiari.eu/d/file.pdf?AUTH=dev"})
    if p == "/notes/all" or p == "/notes/all/":
        return R(200, NOTES)
    m = re.match(r"^/notes/(NT[A-Z]{2})/read/(\d+)$", p)
    if m:
        for n in NOTES.get(m.group(1), []):
            if str(n["evtId"]) == m.group(2):
                n["readStatus"] = True
                return R(200, {"event": {"evtCode": m.group(1), "evtId": n["evtId"], "evtText": n["evtText"]}})
        return R(404, {"error": "not found"})
    if p == "/documents":
        return R(200, DOCUMENTS) if method == "POST" else R(405, {"error": "method not allowed"})
    if p.startswith("/documents/check/"):
        return R(200, {"document": {"available": True}})
    if p.startswith("/documents/read/"):
        return R(200, None, "application/pdf", PDF, {"Content-Disposition": 'attachment; filename="patto.pdf"'})
    if p == "/homeworks/index":
        return R(200, {"items": HOMEWORKS})
    m = re.match(r"^/homeworks/setHomeworkMarkedDone/NEWDC/(\d+)$", p)
    if m:
        for h in HOMEWORKS:
            if str(h["evtId"]) == m.group(1):
                h["homeworkMarkedDone"] = str((kw.get("data") or {}).get("homeworkMarkedDone")) == "true"
        return R(200, {"ok": True})
    if p.startswith("/homeworks/downloadTeacherFile/"):
        return R(200, None, "application/pdf", PDF, {"Content-Disposition": 'attachment; filename="traccia.pdf"'})
    if p == "/subjects":
        return R(200, {"subjects": [{"id": 100 + i, "description": s, "order": i, "teachers": [{"teacherId": f"A{i}", "teacherName": t}]} for i, (s, t) in enumerate(SUBJECTS)]})
    if p == "/periods":
        y = TODAY.year if TODAY.month >= 9 else TODAY.year - 1
        return R(200, {"periods": [
            {"periodCode": "Q1", "periodPos": 1, "periodDesc": "Primo Periodo", "periodLabel": "Trimestre", "isFinal": False, "dateStart": f"{y}-09-10", "dateEnd": f"{y}-12-22", "miurDivisionCode": None},
            {"periodCode": "Q3", "periodPos": 3, "periodDesc": "Secondo Periodo", "periodLabel": "Pentamestre", "isFinal": True, "dateStart": f"{y + 1}-01-07", "dateEnd": f"{y + 1}-06-07", "miurDivisionCode": None},
        ]})
    if p == "/schoolbooks":
        return R(200, {"schoolbooks": BOOKS})
    if p == "/calendar/all":
        return R(200, {"calendar": calendar_days()})
    if p == "/avg/":
        return R(200, {"subjectAverages": {}, "generalAverages": {}})
    return R(200, {})


cv.requests.get = lambda url, headers=None, **kw: fake("GET", url, headers, **kw)
cv.requests.request = lambda method, url, headers=None, **kw: fake(method, url, headers, **kw)
cv.requests.post = lambda url, headers=None, **kw: fake("POST", url, headers, **kw)

import main  # noqa: E402

main.requests.get = lambda url, headers=None, **kw: fake("GET", url, headers, **kw)
main.requests.post = lambda url, headers=None, **kw: fake("POST", url, headers, **kw)


def seed_leaderboards():
    names = ["Marco Bellini", "Sofia Greco", "Luca Moretti", "Alice Fontana", "Davide Russo", "Chiara Marino",
             "Matteo Gallo", "Elena Costa", "Andrea Rizzo", "Martina Lombardi", "Pietro Esposito", "Giorgia Ricci",
             "Tommaso Bruno", "Francesca Colombo", "Riccardo De Luca", "Beatrice Mancini", "Lorenzo Barbieri"]
    year = main.current_school_year()
    for i, name in enumerate(names):
        cls = "5EI" if i < 11 else rng.choice(["5EL", "4EI"])
        user = f"S10{i:06d}A"
        main.upsert_leaderboard_entry(username=user, full_name=name, class_code=cls, school_code="VRIT0007",
                                      hours=float(rng.randint(4, 70)), visible_in_leaderboard=True, school_year=year)
        main.upsert_average_leaderboard_entry(username=user, full_name=name, class_code=cls, school_code="VRIT0007",
                                              subject_name=main.GENERAL_AVERAGE_SUBJECT, period_key=main.GENERAL_AVERAGE_PERIOD_KEY,
                                              period_label="Media generale", average=round(rng.uniform(5.4, 9.2), 2),
                                              visible_in_leaderboard=True, school_year=year)


if __name__ == "__main__":
    import uvicorn

    main.init_db()
    try:
        seed_leaderboards()
    except Exception as exc:  # il seed è solo cosmetico
        print("seed classifiche non riuscito:", exc)
    print(f"Aulera (ClasseViva finto) su http://127.0.0.1:{PORT} — DB: {os.environ['DATABASE_PATH']}")
    uvicorn.run(main.app, host="127.0.0.1", port=PORT, log_level="warning")
