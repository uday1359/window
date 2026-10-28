from app.rule_planner import rule_plan

ROOTS = ["test", "workspace"]
APPS = ["notepad", "calculator"]
ACCEPTANCE = "Create hello.txt in the approved test folder containing exactly: Hello from my AI agent. Read the file back and verify its contents."


def test_acceptance_instruction_produces_exact_plan():
    plan = rule_plan(ACCEPTANCE, ROOTS, APPS)
    assert plan is not None and plan["clarification"] is None
    write, read = plan["steps"]
    assert write == {
        "operation": "file.write",
        "description": "Create hello.txt in the test folder",
        "params": {"root": "test", "path": "hello.txt", "content": "Hello from my AI agent.", "overwrite": False},
    }
    assert read["operation"] == "file.read" and read["params"] == {"root": "test", "path": "hello.txt"}
    assert plan["successCriteria"] == [{"kind": "file_content_equals", "root": "test", "path": "hello.txt", "expected": "Hello from my AI agent."}]


def test_quoted_content_is_taken_verbatim():
    plan = rule_plan('Create notes.txt in the test folder with the text "a. b. Read this"', ROOTS, APPS)
    assert plan["steps"][0]["params"]["content"] == "a. b. Read this"
    assert len(plan["steps"]) == 1  # "Read" inside the quotes is content, not an instruction


def test_missing_content_asks_for_clarification():
    plan = rule_plan("Create report.txt in the test folder", ROOTS, APPS)
    assert plan["steps"] == [] and "contain" in plan["clarification"]


def test_unknown_folder_asks_for_clarification():
    plan = rule_plan("Create a.txt in the secrets folder containing hi", ROOTS, APPS)
    assert "no approved 'secrets' folder" in plan["clarification"]


def test_no_location_uses_dedicated_task_folder():
    plan = rule_plan("Create out.txt containing hi", ROOTS, APPS)
    assert plan["steps"][0]["params"]["root"] == "workspace"
    assert plan["steps"][0]["params"]["path"] == "{task}/out.txt"


def test_no_default_root_asks():
    plan = rule_plan("Create out.txt containing hi", ["test"], APPS)
    assert plan["clarification"]


def test_browser_open_and_search():
    plan = rule_plan("Open https://example.com", ROOTS, APPS)
    assert [s["operation"] for s in plan["steps"]] == ["browser.open", "browser.extract_text"]
    plan = rule_plan("search the web for windows ui automation", ROOTS, APPS)
    assert plan["steps"][0]["params"]["query"] == "windows ui automation"


def test_launch_app_requires_allowlist():
    assert rule_plan("open notepad", ROOTS, APPS)["steps"][0]["params"] == {"app": "notepad"}
    assert "allow list" in rule_plan("launch regedit", ROOTS, APPS)["clarification"]


def test_unrecognised_instruction_falls_through():
    assert rule_plan("Summarise my unread emails and draft replies", ROOTS, APPS) is None


def test_subfolder_paths_are_kept():
    plan = rule_plan("Create reports/2026/q1.md in the test folder containing # Q1", ROOTS, APPS)
    assert plan["steps"][0]["params"]["path"] == "reports/2026/q1.md"


def test_ocr_requests_use_windows_ocr():
    screen = rule_plan("Read the text on the screen", ROOTS, APPS)
    assert screen["steps"] == [{"operation": "desktop.ocr", "description": "Read visible text from the screen with Windows OCR", "params": {}}]
    window = rule_plan('Read text in window "Untitled - Notepad"', ROOTS, APPS)
    assert window["steps"][0]["params"] == {"titleContains": "Untitled - Notepad"}


def test_single_question_research_is_rule_planned_but_compound_research_is_not():
    plan = rule_plan("Research what is new in Python 3.13?", ROOTS, APPS)
    assert plan["steps"] == [{"operation": "browser.research", "description": "Research what is new in Python 3.13 using trustworthy sources", "params": {"query": "what is new in Python 3.13", "maxSources": 3}}]
    assert rule_plan("Research three vendors, then compare their prices, then summarise everything", ROOTS, APPS) is None
