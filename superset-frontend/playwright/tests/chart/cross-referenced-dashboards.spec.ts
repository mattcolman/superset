/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/**
 * E2E migration of the Cypress "Cross-referenced dashboards" suite
 * (explore/chart.test.js).
 *
 * Explore surfaces the dashboards a chart belongs to in two places: the
 * metadata bar under the title ("Not added to any dashboard" / "Added to N
 * dashboards") and the "On dashboards" submenu of the header actions menu,
 * which grows a search box once the chart is on more than `SEARCH_THRESHOLD`
 * (10) dashboards.
 *
 * The Cypress version saved the chart to eleven dashboards one by one through
 * the save modal. Here the modal round-trip is exercised once (it is the
 * behaviour under test), and the remaining memberships are attached through
 * the chart API so the search-threshold and link assertions do not depend on
 * ten repeated UI saves.
 */
import type { Locator, Page } from '@playwright/test';
import { testWithAssets, expect } from '../../helpers/fixtures';
import { TIMEOUT } from '../../utils/constants';
import { ExplorePage } from '../../pages/ExplorePage';
import { DashboardPage } from '../../pages/DashboardPage';
import {
  apiGetChart,
  apiPostChart,
  apiPutChart,
} from '../../helpers/api/chart';
import { getDatasetByName } from '../../helpers/api/dataset';
import { extractIdFromResponse } from '../../helpers/api/assertions';
import { createTestDashboard } from '../dashboard/dashboard-test-helpers';

// SEARCH_THRESHOLD is 10; one more dashboard is needed to show the search box.
const DASHBOARD_COUNT = 11;

const SELECTORS = {
  METADATA_BAR: '[data-test="metadata-bar"]',
  ACTIONS_TRIGGER: '[data-test="actions-trigger"]',
  SAVE_BUTTON: '[data-test="query-save-button"]',
  SAVE_MODAL: '[data-test="save-modal-body"]',
  SAVE_MODAL_SAVE: '[data-test="btn-modal-save"]',
  SUBMENU_TITLE: '.ant-dropdown-menu-submenu-title',
  SUBMENU_POPUP:
    '.ant-dropdown-menu-submenu-popup:not(.ant-dropdown-menu-submenu-hidden)',
} as const;

async function openOnDashboardsSubmenu(page: Page): Promise<Locator> {
  await page.locator(SELECTORS.ACTIONS_TRIGGER).click();
  await page
    .locator(SELECTORS.SUBMENU_TITLE)
    .filter({ hasText: 'On dashboards' })
    .hover();
  const popup = page.locator(SELECTORS.SUBMENU_POPUP).last();
  await expect(popup).toBeVisible({ timeout: TIMEOUT.UI_TRANSITION });
  return popup;
}

async function closeActionsMenu(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(page.locator(SELECTORS.SUBMENU_POPUP)).toHaveCount(0, {
    timeout: TIMEOUT.UI_TRANSITION,
  });
}

testWithAssets(
  'Explore shows the dashboards a chart is cross-referenced from',
  async ({ page, testAssets }, testInfo) => {
    testWithAssets.setTimeout(TIMEOUT.SLOW_TEST);

    const dashboards: Array<{ id: number; name: string }> = [];
    for (let i = 1; i <= DASHBOARD_COUNT; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- werkzeug drops concurrent writes
      dashboards.push(
        await createTestDashboard(page, testAssets, testInfo, {
          prefix: `${i}_xref_dashboard`,
        }),
      );
    }
    const [firstDashboard] = dashboards;

    // Explore keeps Save disabled until the chart's required controls are
    // set, so the chart is created with a complete big_number_total config.
    const dataset = await getDatasetByName(page, 'members_channels_2');
    if (!dataset) {
      throw new Error(
        'members_channels_2 dataset not found — run Superset with --load-examples',
      );
    }
    const chartName = `xref_chart_${Date.now()}_${testInfo.parallelIndex}`;
    const createResponse = await apiPostChart(page, {
      slice_name: chartName,
      datasource_id: dataset.id,
      datasource_type: 'table',
      viz_type: 'big_number_total',
      params: JSON.stringify({
        datasource: `${dataset.id}__table`,
        viz_type: 'big_number_total',
        metric: 'count',
      }),
    });
    expect(createResponse.ok()).toBe(true);
    const chart = { id: await extractIdFromResponse(createResponse) };
    testAssets.trackChart(chart.id);

    const explorePage = new ExplorePage(page);
    await explorePage.goto(chart.id, { timeout: TIMEOUT.EXPLORE_PAGE_LOAD });

    const metadataBar = page.locator(SELECTORS.METADATA_BAR);
    await expect(metadataBar).toContainText('Not added to any dashboard');

    let popup = await openOnDashboardsSubmenu(page);
    await expect(popup).toContainText('None');
    await closeActionsMenu(page);

    // Save through the modal onto the first dashboard.
    const saveButton = page.locator(SELECTORS.SAVE_BUTTON);
    await expect(saveButton).toBeEnabled();
    await saveButton.click();

    const saveModal = page.locator(SELECTORS.SAVE_MODAL);
    await expect(saveModal).toBeVisible({ timeout: TIMEOUT.FORM_LOAD });
    await saveModal
      .getByRole('combobox', { name: 'Select a dashboard' })
      .fill(firstDashboard.name);
    await page
      .locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')
      .locator(`.ant-select-item-option[title="${firstDashboard.name}"]`)
      .click();

    const updateResponse = page.waitForResponse(
      response =>
        response.request().method() === 'PUT' &&
        response.url().includes(`/api/v1/chart/${chart.id}`),
      { timeout: TIMEOUT.API_RESPONSE },
    );
    await page.locator(SELECTORS.SAVE_MODAL_SAVE).click();
    expect((await updateResponse).ok()).toBe(true);
    await expect(saveModal).toHaveCount(0);

    await expect(metadataBar).toContainText('Added to 1 dashboard', {
      timeout: TIMEOUT.API_RESPONSE,
    });
    const savedChart = await (await apiGetChart(page, chart.id)).json();
    expect(
      savedChart.result.dashboards.map((d: { id: number }) => d.id),
    ).toEqual([firstDashboard.id]);

    popup = await openOnDashboardsSubmenu(page);
    await expect(popup).toContainText(firstDashboard.name);
    await closeActionsMenu(page);

    // Attach the remaining dashboards via the API and reload Explore.
    const putResponse = await apiPutChart(page, chart.id, {
      dashboards: dashboards.map(d => d.id),
    });
    expect(putResponse.ok()).toBe(true);

    await explorePage.goto(chart.id, { timeout: TIMEOUT.EXPLORE_PAGE_LOAD });
    await expect(metadataBar).toContainText(
      `Added to ${DASHBOARD_COUNT} dashboards`,
    );

    // Above SEARCH_THRESHOLD the submenu gains a search box.
    popup = await openOnDashboardsSubmenu(page);
    // The search box lives in a disabled menu item (so clicks don't close the
    // menu), which fails Playwright's enabled check; the input itself is live.
    const search = popup.getByPlaceholder('Search');
    await expect(search).toBeVisible();
    await search.fill('1_xref', { force: true });
    await expect(popup).toContainText(firstDashboard.name);
    await expect(popup).not.toContainText(dashboards[1].name);
    await search.fill('Blahblah', { force: true });
    await expect(popup).toContainText('No results found');
    await popup.locator('[aria-label="close-circle"]').click({ force: true });
    await expect(popup).toContainText(dashboards[1].name);

    // Each entry links to the dashboard; follow one without a new tab.
    const link = popup.locator('a', { hasText: firstDashboard.name }).first();
    await link.evaluate(el => el.removeAttribute('target'));
    await link.click();

    await page.waitForURL(`**/dashboard/${firstDashboard.id}**`, {
      timeout: TIMEOUT.PAGE_LOAD,
    });
    await new DashboardPage(page).waitForLoad();
    await expect(
      page
        .locator('[data-test="dashboard-header-container"]')
        .locator('[data-test="editable-title-input"]')
        .first(),
    ).toHaveValue(firstDashboard.name);
  },
);
