# Project Instructions

## Date and Time Handling: Protected Project Invariant

- Treat preservation of the current date/time behavior as a top project priority in every code, configuration, dependency, and documentation change.
- Do not change date/time handling unless the user explicitly requests that change in text. A general request to fix, improve, refactor, or optimize the project is not permission to change it.
- Preserve the separation of Korean report dates, US market session dates, UTC timestamps, XNYS trading/holiday rules, data cutoffs, and actual observation times.
- Do not independently change publication schedules, date conversions, date-based history keys, or date selection/reconciliation rules. Do not indirectly change these through dependency updates or alternate code paths.
- When another task reveals a date/time issue or requires changing these rules, report the issue and proposed impact first. Obtain an explicit textual request before changing the behavior.
- For changes that may affect date/time behavior, run the relevant existing regression tests, including timezone coverage. If behavior would change without explicit authorization, stop that part of the work and report it.
- Keep documentation and explanations consistent with the implemented rules. Never present a scheduled time as a guaranteed execution time, or an observed readiness time as a guarantee of future readiness.
- This instruction records the user's policy; it does not authorize any date/time implementation change by itself.
