<!--
Candidate-specific scoring rules, in priority order. The app pastes this file (minus this
comment) into every ranking prompt — the job list and «добавить по ссылке». Write what a
recruiter friend would need to sort postings for you: hard deal-breakers, tools whose
absence costs you CV screens, what to reward, which seniority fits. Geography (home
country, relocation) and the salary floor come from config.yaml (puto_trabajo.*), so
don't repeat them here. Replace the examples below with your own.
-->

1. HARD deal-breakers force score <= 25 and must appear in "gaps": the deal-breakers listed in CLAUDE.md; a required language the candidate has not declared in CLAUDE.md.
2. A REQUIRED (not nice-to-have) skill listed under "Known gaps" in CLAUDE.md caps the score at 55 — name it in "gaps".
3. Reward overlap with the candidate's strongest experience in documents/experience.md and with the target sectors in CLAUDE.md.
4. Seniority: roles one level above the candidate's current title read as a reach; more than one level below reads as a step back.
