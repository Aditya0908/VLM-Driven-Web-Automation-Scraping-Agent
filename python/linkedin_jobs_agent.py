#!/usr/bin/env python3
"""
LinkedIn job discovery, relevance filtering, description scraping, and Easy Apply automation.

This script is configuration-driven. It reads a JSON config file, then:
1) logs into LinkedIn (or reuses a saved session),
2) searches jobs,
3) scrapes job details and full descriptions,
4) evaluates each role against keyword requirements,
5) optionally attempts Easy Apply form filling.

Important:
- LinkedIn frequently changes UI selectors and may enforce anti-automation checks.
- Keep `application.dry_run = true` until you fully trust your config.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlencode

from playwright.sync_api import (
    Browser,
    BrowserContext,
    Locator,
    Page,
    TimeoutError as PlaywrightTimeoutError,
    sync_playwright,
)

JOBS_URL_BASE = "https://www.linkedin.com/jobs/search/"
LOGIN_URL = "https://www.linkedin.com/login"
FEED_URL = "https://www.linkedin.com/feed/"

JOB_CARD_SELECTORS = [
    "li.jobs-search-results__list-item",
    "ul.scaffold-layout__list-container li",
    "li.scaffold-layout__list-item",
]

JOB_DETAILS_ROOT_SELECTORS = [
    ".scaffold-layout__detail",
    ".jobs-search__job-details--container",
]

JOB_TITLE_SELECTORS = [
    ".job-details-jobs-unified-top-card__job-title h1",
    "h1.t-24",
]

COMPANY_SELECTORS = [
    ".job-details-jobs-unified-top-card__company-name a",
    ".job-details-jobs-unified-top-card__company-name",
]

LOCATION_SELECTORS = [
    ".job-details-jobs-unified-top-card__primary-description-container span",
    ".job-details-jobs-unified-top-card__bullet",
]

INSIGHT_SELECTORS = [
    ".job-details-jobs-unified-top-card__job-insight",
    ".jobs-unified-top-card__job-insight",
    ".description__job-criteria-item",
]

DESCRIPTION_EXPAND_SELECTORS = [
    "button[aria-label*='Click to see more description']",
    "button:has-text('See more')",
]

DESCRIPTION_SELECTORS = [
    ".jobs-description-content__text",
    ".jobs-box__html-content",
    ".jobs-description__content",
]

EASY_APPLY_BUTTON_SELECTORS = [
    "button.jobs-apply-button--top-card",
    "button[aria-label*='Easy Apply']",
    "button:has-text('Easy Apply')",
]

EASY_APPLY_MODAL_SELECTORS = [
    ".jobs-easy-apply-modal",
    "div[role='dialog']",
]

PHONE_INPUT_SELECTORS = [
    "input[id*='phone']",
    "input[name*='phone']",
    "input[aria-label*='Phone']",
]

CITY_INPUT_SELECTORS = [
    "input[id*='city']",
    "input[name*='city']",
    "input[aria-label*='City']",
]

TEXT_INPUT_SELECTORS = [
    "input[type='text']",
    "input[type='number']",
    "textarea",
    "select",
]

RESUME_UPLOAD_SELECTORS = [
    "input[type='file'][name*='resume']",
    "input[type='file'][id*='resume']",
    "input[type='file'][aria-label*='Resume']",
    "input[type='file']",
]

COVER_UPLOAD_SELECTORS = [
    "input[type='file'][name*='cover']",
    "input[type='file'][id*='cover']",
]

NEXT_BUTTON_SELECTORS = [
    "button[aria-label='Continue to next step']",
    "button:has-text('Next')",
    "button:has-text('Review')",
]

SUBMIT_BUTTON_SELECTORS = [
    "button[aria-label='Submit application']",
    "button:has-text('Submit application')",
]

DONE_BUTTON_SELECTORS = [
    "button:has-text('Done')",
]

DISMISS_BUTTON_SELECTORS = [
    "button[aria-label='Dismiss']",
    "button[aria-label='Close']",
]

DISCARD_BUTTON_SELECTORS = [
    "button:has-text('Discard')",
]

SUCCESS_TEXT_SELECTORS = [
    "text=Application submitted",
    "text=Your application was sent",
]

LOGIN_FORM_SELECTORS = [
    "input#username",
    "input[name='session_key']",
]

EXPERIENCE_LEVEL_CODES = {
    "internship": "1",
    "entry": "2",
    "associate": "3",
    "mid_senior": "4",
    "director": "5",
    "executive": "6",
}

WORKPLACE_TYPE_CODES = {
    "on_site": "1",
    "remote": "2",
    "hybrid": "3",
}

DATE_POSTED_CODES = {
    1: "r86400",
    7: "r604800",
    30: "r2592000",
}


@dataclass
class MatchResult:
    is_match: bool
    score: int
    must_have_hits: List[str]
    preferred_hits: List[str]
    excluded_hits: List[str]
    missing_must_have: List[str]
    reasons: List[str]

    def to_dict(self) -> Dict[str, Any]:
        return {
            "is_match": self.is_match,
            "score": self.score,
            "must_have_hits": self.must_have_hits,
            "preferred_hits": self.preferred_hits,
            "excluded_hits": self.excluded_hits,
            "missing_must_have": self.missing_must_have,
            "reasons": self.reasons,
        }


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def slugify(value: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9]+", "-", value.strip().lower())
    cleaned = cleaned.strip("-")
    return cleaned[:64] if cleaned else "run"


def bool_from_value(value: Any, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    normalized = str(value).strip().lower()
    if normalized in {"1", "true", "yes", "y"}:
        return True
    if normalized in {"0", "false", "no", "n"}:
        return False
    return default


def normalize_keywords(values: Any) -> List[str]:
    if not isinstance(values, list):
        return []
    normalized: List[str] = []
    for value in values:
        token = str(value).strip().lower()
        if token and token not in normalized:
            normalized.append(token)
    return normalized


def safe_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


class LinkedInJobsAgent:
    def __init__(
        self,
        config: Dict[str, Any],
        config_path: Path,
        output_root: Path,
        force_apply: Optional[bool] = None,
        force_headless: Optional[bool] = None,
        max_jobs_override: Optional[int] = None,
    ) -> None:
        self.config = config
        self.config_path = config_path
        self.run_started_at = utc_now()

        runtime = config.get("runtime", {})
        headless_config = bool_from_value(runtime.get("headless"), default=False)
        self.headless = headless_config if force_headless is None else force_headless
        self.slow_mo_ms = safe_int(runtime.get("slow_mo_ms"), 0)
        self.action_timeout_ms = safe_int(runtime.get("action_timeout_ms"), 12_000)
        self.navigation_timeout_ms = safe_int(
            runtime.get("navigation_timeout_ms"),
            45_000,
        )
        self.screenshot_each_job = bool_from_value(
            runtime.get("screenshot_each_job"),
            default=False,
        )

        search = config.get("search", {})
        self.max_jobs_to_review = safe_int(search.get("max_jobs_to_review"), 30)
        if max_jobs_override is not None:
            self.max_jobs_to_review = max_jobs_override

        application = config.get("application", {})
        enabled = bool_from_value(application.get("enabled"), default=False)
        self.apply_enabled = enabled if force_apply is None else force_apply
        self.dry_run = bool_from_value(application.get("dry_run"), default=True)
        self.max_applications_per_run = safe_int(
            application.get("max_applications_per_run"),
            3,
        )

        run_name = slugify(config.get("run_name") or config.get("goal") or "linkedin-jobs")
        timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")
        self.output_dir = output_root / f"{run_name}-{timestamp}"
        self.output_dir.mkdir(parents=True, exist_ok=True)

        self.log_lines: List[str] = []
        self.scraped_jobs: List[Dict[str, Any]] = []
        self.relevant_jobs: List[Dict[str, Any]] = []
        self.application_log: List[Dict[str, Any]] = []

        self._log(
            f"Initialized run. config={self.config_path} output_dir={self.output_dir} "
            f"headless={self.headless} max_jobs={self.max_jobs_to_review} "
            f"apply_enabled={self.apply_enabled} dry_run={self.dry_run}",
        )

    def _log(self, message: str) -> None:
        line = f"[{utc_now()}] {message}"
        self.log_lines.append(line)
        print(line)

    def _write_json(self, filename: str, data: Any) -> Path:
        target = self.output_dir / filename
        target.write_text(f"{json.dumps(data, indent=2, ensure_ascii=True)}\n", encoding="utf-8")
        return target

    def _write_log(self) -> Path:
        target = self.output_dir / "agent.log"
        target.write_text("\n".join(self.log_lines) + "\n", encoding="utf-8")
        return target

    def _first_visible(self, page: Page, selectors: List[str]) -> Tuple[Optional[Locator], Optional[str]]:
        for selector in selectors:
            try:
                locator = page.locator(selector)
                count = locator.count()
                if count == 0:
                    continue
                for index in range(min(count, 3)):
                    candidate = locator.nth(index)
                    if candidate.is_visible():
                        return candidate, selector
            except Exception:
                continue
        return None, None

    def _first_text(self, page: Page, selectors: List[str]) -> str:
        for selector in selectors:
            try:
                locator = page.locator(selector)
                if locator.count() == 0:
                    continue
                text = (locator.first.inner_text(timeout=1000) or "").strip()
                if text:
                    return text
                text_content = (locator.first.text_content(timeout=1000) or "").strip()
                if text_content:
                    return text_content
            except Exception:
                continue
        return ""

    def _all_texts(self, page: Page, selectors: List[str], limit: int = 15) -> List[str]:
        all_items: List[str] = []
        for selector in selectors:
            try:
                locator = page.locator(selector)
                count = min(locator.count(), limit)
                for idx in range(count):
                    text = (locator.nth(idx).inner_text(timeout=800) or "").strip()
                    if text and text not in all_items:
                        all_items.append(text)
            except Exception:
                continue
        return all_items[:limit]

    def _click_first_visible(self, page: Page, selectors: List[str]) -> bool:
        locator, selector = self._first_visible(page, selectors)
        if not locator:
            return False
        try:
            locator.scroll_into_view_if_needed(timeout=2000)
            locator.click(timeout=2500)
            self._log(f"Clicked selector: {selector}")
            return True
        except Exception:
            return False

    def _wait_for_any(self, page: Page, selectors: List[str], timeout_ms: int) -> Optional[str]:
        if not selectors:
            return None
        timeout_per_selector = max(500, int(timeout_ms / max(len(selectors), 1)))
        for selector in selectors:
            try:
                page.locator(selector).first.wait_for(state="visible", timeout=timeout_per_selector)
                return selector
            except PlaywrightTimeoutError:
                continue
            except Exception:
                continue
        return None

    def _is_logged_in(self, page: Page) -> bool:
        try:
            if "/feed" in page.url:
                return True
            nav = page.locator("a[href*='/jobs/']")
            return nav.count() > 0
        except Exception:
            return False

    def _resolve_credential(self, key: str, env_key: str) -> str:
        linkedin_cfg = self.config.get("linkedin", {})
        value = linkedin_cfg.get(key)
        if value:
            return str(value)
        env_name = linkedin_cfg.get(env_key, "")
        if env_name:
            return os.getenv(str(env_name), "")
        default_env = "LINKEDIN_EMAIL" if key == "email" else "LINKEDIN_PASSWORD"
        return os.getenv(default_env, "")

    def _login(self, page: Page, context: BrowserContext) -> None:
        page.goto(FEED_URL, wait_until="domcontentloaded")
        if self._is_logged_in(page):
            self._log("LinkedIn session already authenticated.")
            self._save_storage_state_if_configured(context)
            return

        email = self._resolve_credential("email", "email_env")
        password = self._resolve_credential("password", "password_env")

        if email and password:
            self._log("Logging in with configured credentials.")
            page.goto(LOGIN_URL, wait_until="domcontentloaded")
            page.locator("#username").first.fill(email)
            page.locator("#password").first.fill(password)
            page.locator("button[type='submit']").first.click()
            page.wait_for_timeout(2500)
        else:
            runtime = self.config.get("runtime", {})
            manual_allowed = bool_from_value(runtime.get("allow_manual_login"), default=not self.headless)
            if not manual_allowed:
                raise RuntimeError(
                    "Not logged in and no credentials found. Set linkedin.email/password "
                    "or environment variables LINKEDIN_EMAIL and LINKEDIN_PASSWORD.",
                )
            self._log("Manual login required. Please complete login in the opened browser window.")
            page.goto(LOGIN_URL, wait_until="domcontentloaded")
            manual_timeout_ms = safe_int(runtime.get("manual_login_timeout_ms"), 180_000)
            deadline = time.time() + (manual_timeout_ms / 1000)
            while time.time() < deadline:
                page.wait_for_timeout(1500)
                if self._is_logged_in(page):
                    break

        if "checkpoint" in page.url or "challenge" in page.url:
            raise RuntimeError(
                "LinkedIn challenge/checkpoint detected. Complete challenge and rerun with saved storage state.",
            )
        if not self._is_logged_in(page):
            raise RuntimeError("Unable to confirm LinkedIn login.")

        self._log("Login successful.")
        self._save_storage_state_if_configured(context)

    def _save_storage_state_if_configured(self, context: BrowserContext) -> None:
        linkedin_cfg = self.config.get("linkedin", {})
        storage_state_path = linkedin_cfg.get("storage_state_path")
        if not storage_state_path:
            return
        path_obj = Path(storage_state_path).expanduser().resolve()
        path_obj.parent.mkdir(parents=True, exist_ok=True)
        context.storage_state(path=str(path_obj))
        self._log(f"Saved storage state to {path_obj}")

    def _build_search_url(self) -> str:
        search = self.config.get("search", {})
        params: Dict[str, Any] = {}

        keywords = str(search.get("keywords", "")).strip()
        location = str(search.get("location", "")).strip()
        if keywords:
            params["keywords"] = keywords
        if location:
            params["location"] = location

        if bool_from_value(search.get("easy_apply_only"), default=True):
            params["f_AL"] = "true"

        sort_by_recent = bool_from_value(search.get("sort_by_recent"), default=True)
        if sort_by_recent:
            params["sortBy"] = "DD"

        experience_levels = search.get("experience_levels", [])
        if isinstance(experience_levels, list) and experience_levels:
            mapped = [
                EXPERIENCE_LEVEL_CODES[level]
                for level in experience_levels
                if level in EXPERIENCE_LEVEL_CODES
            ]
            if mapped:
                params["f_E"] = ",".join(mapped)

        workplace_types = search.get("workplace_types", [])
        if isinstance(workplace_types, list) and workplace_types:
            mapped = [
                WORKPLACE_TYPE_CODES[item]
                for item in workplace_types
                if item in WORKPLACE_TYPE_CODES
            ]
            if mapped:
                params["f_WT"] = ",".join(mapped)

        posted_within_days = safe_int(search.get("posted_within_days"), 0)
        if posted_within_days in DATE_POSTED_CODES:
            params["f_TPR"] = DATE_POSTED_CODES[posted_within_days]

        raw_params = search.get("raw_params", {})
        if isinstance(raw_params, dict):
            for key, value in raw_params.items():
                params[str(key)] = value

        encoded = urlencode(params, doseq=True)
        return f"{JOBS_URL_BASE}?{encoded}" if encoded else JOBS_URL_BASE

    def _resolve_job_card_selector(self, page: Page) -> str:
        for selector in JOB_CARD_SELECTORS:
            try:
                count = page.locator(selector).count()
                if count > 0:
                    return selector
            except Exception:
                continue
        raise RuntimeError("Unable to find job cards on LinkedIn search results page.")

    def _expand_results(self, page: Page, card_selector: str) -> None:
        target = self.max_jobs_to_review
        last_count = page.locator(card_selector).count()
        idle_rounds = 0

        self._log(f"Initial visible job cards: {last_count}. Loading more up to {target}.")
        while last_count < target and idle_rounds < 8:
            page.mouse.wheel(0, 2400)
            page.wait_for_timeout(900)
            updated = page.locator(card_selector).count()
            if updated <= last_count:
                idle_rounds += 1
            else:
                idle_rounds = 0
            last_count = updated

        self._log(f"Final visible job cards after scrolling: {last_count}.")

    def _extract_job_url(self, page: Page, card: Locator) -> str:
        try:
            href = card.locator("a").first.get_attribute("href", timeout=1000)
            if href:
                return href
        except Exception:
            pass
        return page.url

    def _extract_job_id(self, url: str) -> str:
        match = re.search(r"/jobs/view/(\d+)", url)
        return match.group(1) if match else ""

    def _scrape_current_job(self, page: Page, card_index: int, card_url: str) -> Dict[str, Any]:
        self._click_first_visible(page, DESCRIPTION_EXPAND_SELECTORS)
        page.wait_for_timeout(500)

        title = self._first_text(page, JOB_TITLE_SELECTORS)
        company = self._first_text(page, COMPANY_SELECTORS)
        location = self._first_text(page, LOCATION_SELECTORS)
        insights = self._all_texts(page, INSIGHT_SELECTORS, limit=20)
        description = self._first_text(page, DESCRIPTION_SELECTORS)
        easy_apply_available = self._first_visible(page, EASY_APPLY_BUTTON_SELECTORS)[0] is not None

        job_url = page.url if "/jobs/view/" in page.url else card_url
        job_id = self._extract_job_id(job_url)

        return {
            "card_index": card_index,
            "job_id": job_id,
            "job_url": job_url,
            "title": title,
            "company": company,
            "location": location,
            "insights": insights,
            "description": description,
            "easy_apply_available": easy_apply_available,
            "scraped_at": utc_now(),
        }

    def _evaluate_match(self, job: Dict[str, Any]) -> MatchResult:
        requirements = self.config.get("requirements", {})
        must_have = normalize_keywords(requirements.get("must_have_keywords"))
        preferred = normalize_keywords(requirements.get("preferred_keywords"))
        excluded = normalize_keywords(requirements.get("excluded_keywords"))

        combined_text = " ".join(
            [
                str(job.get("title", "")),
                str(job.get("company", "")),
                str(job.get("location", "")),
                " ".join(job.get("insights", [])),
                str(job.get("description", "")),
            ],
        ).lower()

        must_hits = [token for token in must_have if token in combined_text]
        preferred_hits = [token for token in preferred if token in combined_text]
        excluded_hits = [token for token in excluded if token in combined_text]
        missing_must = [token for token in must_have if token not in must_hits]

        require_all_must = bool_from_value(requirements.get("require_all_must_have"), default=False)
        minimum_keyword_hits = safe_int(requirements.get("minimum_keyword_hits"), 1)
        minimum_score = safe_int(requirements.get("minimum_score"), 1)

        score = (len(must_hits) * 3) + len(preferred_hits) - (len(excluded_hits) * 5)
        total_hits = len(must_hits) + len(preferred_hits)
        reasons: List[str] = []

        is_match = True
        if excluded_hits:
            is_match = False
            reasons.append(f"Excluded keywords matched: {', '.join(excluded_hits)}")
        if require_all_must and missing_must:
            is_match = False
            reasons.append(f"Missing required keywords: {', '.join(missing_must)}")
        if total_hits < minimum_keyword_hits:
            is_match = False
            reasons.append(
                f"Keyword hits below minimum ({total_hits} < {minimum_keyword_hits})",
            )
        if score < minimum_score:
            is_match = False
            reasons.append(f"Score below minimum ({score} < {minimum_score})")
        if is_match:
            reasons.append("Role passed all configured requirement checks.")

        return MatchResult(
            is_match=is_match,
            score=score,
            must_have_hits=must_hits,
            preferred_hits=preferred_hits,
            excluded_hits=excluded_hits,
            missing_must_have=missing_must,
            reasons=reasons,
        )

    def _fill_by_label(self, page: Page, label: str, value: str) -> bool:
        try:
            locator = page.get_by_label(label, exact=False)
            if locator.count() == 0:
                return False
            field = locator.first
            tag_name = field.evaluate("el => el.tagName.toLowerCase()")
            if tag_name == "select":
                try:
                    field.select_option(label=value)
                except Exception:
                    field.select_option(value=value)
                return True
            field.fill(value)
            return True
        except Exception:
            return False

    def _fill_first_input(self, page: Page, selectors: List[str], value: str) -> bool:
        if not value:
            return False
        for selector in selectors:
            try:
                locator = page.locator(selector)
                if locator.count() == 0:
                    continue
                target = locator.first
                if not target.is_visible():
                    continue
                target.fill(value, timeout=1500)
                self._log(f"Filled field using selector {selector}")
                return True
            except Exception:
                continue
        return False

    def _upload_first_file(self, page: Page, selectors: List[str], file_path: str) -> bool:
        if not file_path:
            return False
        resolved = Path(file_path).expanduser().resolve()
        if not resolved.exists():
            self._log(f"Upload file does not exist: {resolved}")
            return False

        for selector in selectors:
            try:
                locator = page.locator(selector)
                if locator.count() == 0:
                    continue
                locator.first.set_input_files(str(resolved))
                self._log(f"Uploaded file for selector {selector}: {resolved}")
                return True
            except Exception:
                continue
        return False

    def _collect_inline_errors(self, page: Page) -> List[str]:
        errors: List[str] = []
        selectors = [
            ".artdeco-inline-feedback__message",
            ".fb-dash-form-element__error-field",
            ".artdeco-text-input--error",
        ]
        for selector in selectors:
            try:
                locator = page.locator(selector)
                count = min(locator.count(), 6)
                for idx in range(count):
                    text = (locator.nth(idx).inner_text(timeout=500) or "").strip()
                    if text and text not in errors:
                        errors.append(text)
            except Exception:
                continue
        return errors

    def _dismiss_easy_apply(self, page: Page) -> None:
        self._click_first_visible(page, DISMISS_BUTTON_SELECTORS)
        page.wait_for_timeout(400)
        self._click_first_visible(page, DISCARD_BUTTON_SELECTORS)
        page.wait_for_timeout(400)

    def _attempt_easy_apply(self, page: Page, job: Dict[str, Any]) -> Dict[str, Any]:
        app_cfg = self.config.get("application", {})
        dry_run = self.dry_run

        if not self._click_first_visible(page, EASY_APPLY_BUTTON_SELECTORS):
            return {"status": "skipped", "reason": "easy_apply_button_not_found"}

        modal_selector = self._wait_for_any(page, EASY_APPLY_MODAL_SELECTORS, timeout_ms=7000)
        if not modal_selector:
            return {"status": "failed", "reason": "easy_apply_modal_not_visible"}

        page.wait_for_timeout(700)
        contact = app_cfg.get("contact", {})
        self._fill_first_input(page, PHONE_INPUT_SELECTORS, str(contact.get("phone", "")))
        self._fill_first_input(page, CITY_INPUT_SELECTORS, str(contact.get("city", "")))

        if isinstance(app_cfg.get("default_answers"), dict):
            for label, value in app_cfg["default_answers"].items():
                self._fill_by_label(page, str(label), str(value))

        if isinstance(app_cfg.get("question_answers"), dict):
            for question, answer in app_cfg["question_answers"].items():
                filled = self._fill_by_label(page, str(question), str(answer))
                if not filled:
                    self._fill_first_input(page, TEXT_INPUT_SELECTORS, str(answer))

        self._upload_first_file(page, RESUME_UPLOAD_SELECTORS, str(app_cfg.get("resume_path", "")))
        self._upload_first_file(page, COVER_UPLOAD_SELECTORS, str(app_cfg.get("cover_letter_path", "")))

        max_form_steps = safe_int(app_cfg.get("max_form_steps"), 12)
        for _ in range(max_form_steps):
            for label, value in (app_cfg.get("default_answers") or {}).items():
                self._fill_by_label(page, str(label), str(value))

            if self._first_visible(page, SUBMIT_BUTTON_SELECTORS)[0] is not None:
                if dry_run:
                    self._dismiss_easy_apply(page)
                    return {
                        "status": "dry_run_ready_to_submit",
                        "reason": "submit_button_reached_but_dry_run_enabled",
                    }
                if not self._click_first_visible(page, SUBMIT_BUTTON_SELECTORS):
                    return {"status": "failed", "reason": "submit_button_click_failed"}
                page.wait_for_timeout(1800)
                if self._wait_for_any(page, SUCCESS_TEXT_SELECTORS, timeout_ms=6000):
                    self._click_first_visible(page, DONE_BUTTON_SELECTORS)
                    return {"status": "submitted", "reason": "application_submission_confirmed"}
                self._click_first_visible(page, DONE_BUTTON_SELECTORS)
                return {"status": "submitted", "reason": "submit_clicked_no_confirmation_text"}

            moved = self._click_first_visible(page, NEXT_BUTTON_SELECTORS)
            if moved:
                page.wait_for_timeout(1200)
                continue

            errors = self._collect_inline_errors(page)
            self._dismiss_easy_apply(page)
            return {
                "status": "blocked",
                "reason": "unable_to_advance_easy_apply_form",
                "errors": errors,
            }

        self._dismiss_easy_apply(page)
        return {
            "status": "blocked",
            "reason": "max_form_steps_reached_without_submit",
            "errors": self._collect_inline_errors(page),
        }

    def _new_context(self, browser: Browser) -> BrowserContext:
        linkedin_cfg = self.config.get("linkedin", {})
        storage_state_path = linkedin_cfg.get("storage_state_path")

        context_kwargs: Dict[str, Any] = {}
        viewport = self.config.get("runtime", {}).get("viewport")
        if isinstance(viewport, dict):
            width = safe_int(viewport.get("width"), 1400)
            height = safe_int(viewport.get("height"), 920)
            context_kwargs["viewport"] = {"width": width, "height": height}

        if storage_state_path:
            candidate = Path(storage_state_path).expanduser().resolve()
            if candidate.exists():
                context_kwargs["storage_state"] = str(candidate)
                self._log(f"Using existing storage state: {candidate}")

        return browser.new_context(**context_kwargs)

    def run(self) -> Dict[str, Any]:
        run_error: Optional[str] = None
        search_url = self._build_search_url()
        self._log(f"Search URL: {search_url}")

        try:
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(
                    headless=self.headless,
                    slow_mo=self.slow_mo_ms,
                    args=["--disable-blink-features=AutomationControlled"],
                )
                context = self._new_context(browser)
                page = context.new_page()
                page.set_default_timeout(self.action_timeout_ms)
                page.set_default_navigation_timeout(self.navigation_timeout_ms)

                self._login(page, context)

                page.goto(search_url, wait_until="domcontentloaded")
                page.wait_for_timeout(1500)
                if self._wait_for_any(page, LOGIN_FORM_SELECTORS, timeout_ms=1500):
                    raise RuntimeError("Session redirected to login page after search navigation.")

                card_selector = self._resolve_job_card_selector(page)
                self._expand_results(page, card_selector)

                cards = page.locator(card_selector)
                visible_cards = cards.count()
                review_count = min(visible_cards, self.max_jobs_to_review)
                self._log(f"Processing {review_count} job cards.")

                applications_sent = 0

                for index in range(review_count):
                    cards = page.locator(card_selector)
                    card = cards.nth(index)
                    try:
                        card.scroll_into_view_if_needed(timeout=2000)
                        card_url = self._extract_job_url(page, card)
                        card.click(timeout=3000)
                        page.wait_for_timeout(1100)
                        self._wait_for_any(page, JOB_DETAILS_ROOT_SELECTORS, timeout_ms=5000)
                    except Exception as exc:
                        self._log(f"Failed to open card {index + 1}: {exc}")
                        continue

                    job_data = self._scrape_current_job(page, index + 1, card_url)
                    match = self._evaluate_match(job_data)
                    job_data["match"] = match.to_dict()
                    self.scraped_jobs.append(job_data)

                    if self.screenshot_each_job:
                        screenshot_path = self.output_dir / f"job-{index + 1:03}.png"
                        try:
                            page.screenshot(path=str(screenshot_path), full_page=False)
                            job_data["screenshot"] = str(screenshot_path)
                        except Exception:
                            pass

                    self._log(
                        f"Job {index + 1}/{review_count}: "
                        f"title='{job_data.get('title', '')}' "
                        f"company='{job_data.get('company', '')}' "
                        f"score={match.score} match={match.is_match}",
                    )

                    if match.is_match:
                        self.relevant_jobs.append(job_data)

                    if (
                        self.apply_enabled
                        and match.is_match
                        and job_data.get("easy_apply_available")
                        and applications_sent < self.max_applications_per_run
                    ):
                        app_result = self._attempt_easy_apply(page, job_data)
                        app_entry = {
                            "job_id": job_data.get("job_id"),
                            "job_url": job_data.get("job_url"),
                            "title": job_data.get("title"),
                            "company": job_data.get("company"),
                            "attempted_at": utc_now(),
                            "result": app_result,
                            "dry_run": self.dry_run,
                        }
                        self.application_log.append(app_entry)
                        self._log(
                            f"Easy Apply result for job {job_data.get('job_id') or job_data.get('job_url')}: "
                            f"{app_result}",
                        )
                        if app_result.get("status") in {"submitted", "dry_run_ready_to_submit"}:
                            applications_sent += 1

                context.close()
                browser.close()

        except Exception as exc:
            run_error = str(exc)
            self._log(f"Run error: {exc}")

        scraped_path = self._write_json("scraped_jobs.json", self.scraped_jobs)
        relevant_path = self._write_json("relevant_jobs.json", self.relevant_jobs)
        applications_path = self._write_json("application_log.json", self.application_log)

        summary = {
            "started_at": self.run_started_at,
            "completed_at": utc_now(),
            "config_path": str(self.config_path),
            "output_dir": str(self.output_dir),
            "search_url": search_url,
            "headless": self.headless,
            "apply_enabled": self.apply_enabled,
            "dry_run": self.dry_run,
            "max_jobs_to_review": self.max_jobs_to_review,
            "scraped_jobs_count": len(self.scraped_jobs),
            "relevant_jobs_count": len(self.relevant_jobs),
            "application_attempts_count": len(self.application_log),
            "run_error": run_error,
            "artifacts": {
                "scraped_jobs": str(scraped_path),
                "relevant_jobs": str(relevant_path),
                "application_log": str(applications_path),
                "agent_log": str(self.output_dir / "agent.log"),
            },
        }
        summary_path = self._write_json("run_summary.json", summary)
        log_path = self._write_log()
        summary["artifacts"]["run_summary"] = str(summary_path)
        summary["artifacts"]["agent_log"] = str(log_path)
        return summary


def load_config(path: Path) -> Dict[str, Any]:
    if not path.exists():
        raise FileNotFoundError(f"Config file not found: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def parse_args(argv: List[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "LinkedIn jobs automation agent. Reads JSON config, scrapes jobs, "
            "evaluates relevance, and optionally fills Easy Apply forms."
        ),
    )
    parser.add_argument(
        "--config",
        required=True,
        help="Path to JSON config file (see examples/linkedin-job-config.example.json).",
    )
    parser.add_argument(
        "--output-root",
        default="runs/linkedin",
        help="Directory where run artifacts will be written.",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Force enable application attempts for this run.",
    )
    parser.add_argument(
        "--headless",
        choices=["true", "false"],
        help="Override headless mode from config runtime.",
    )
    parser.add_argument(
        "--max-jobs",
        type=int,
        help="Override search.max_jobs_to_review for this run.",
    )
    return parser.parse_args(argv)


def main(argv: List[str]) -> int:
    args = parse_args(argv)
    config_path = Path(args.config).expanduser().resolve()
    output_root = Path(args.output_root).expanduser().resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    config = load_config(config_path)

    force_apply = True if args.apply else None
    force_headless: Optional[bool] = None
    if args.headless:
        force_headless = args.headless == "true"

    agent = LinkedInJobsAgent(
        config=config,
        config_path=config_path,
        output_root=output_root,
        force_apply=force_apply,
        force_headless=force_headless,
        max_jobs_override=args.max_jobs,
    )
    summary = agent.run()
    print(json.dumps(summary, indent=2, ensure_ascii=True))
    return 1 if summary.get("run_error") else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
