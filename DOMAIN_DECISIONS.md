# Academic Sentinel — domain decision register

This document records implementation defaults pending confirmation by the university. It does not claim those defaults are institutional policy.

| Topic | Safe implementation default | Requires institutional decision |
|---|---|---|
| Academic term | Explicit term with unique code and date range; semester number is student standing only | Term naming, year boundaries, short/summer terms |
| Prediction target | No default target; training requires an explicit target column and target definition | Fail course, low term GPA, dropout, or another distinct outcome; prediction cutoff and lead time |
| Student visibility | Prediction routes deny Student role until enabled by server configuration | Whether/how students see a reviewed prediction or alert |
| Risk thresholds | No fallback score or rule-based “AI”; threshold policy must be explicitly configured | Thresholds, owner, effective date and review cadence |
| Teacher scope | Assigned course offering and its enrolled students | Whether advisors or department heads have wider scope |
| Account roles | Admin, Teacher, Student; Advisor/Registrar deferred | Whether Advisor and Registrar are distinct roles/permissions |
| Attendance | Store per-session status; do not infer percentage until policy is defined | Excused absences, late arrivals, denominator, minimum attendance |
| Marks | Assessment score bounded by max score; optional assessment weights | Grading scale, weight sum rules, GPA conversion, late/missing work |
| Deletion | Deactivate people/courses and preserve academic history | Retention duration, erasure exceptions and archival requirements |
| Notifications | Persistent in-app records first; no email or realtime delivery enabled | Delivery channels, consent, escalation schedule |
| Dataset | Local approved CSV only; never committed or sent externally | Data owner, permitted columns, lawful basis, retention and de-identification |

Synthetic seed records are for local development only. They are not university records, training data, or evidence of predictive performance.
