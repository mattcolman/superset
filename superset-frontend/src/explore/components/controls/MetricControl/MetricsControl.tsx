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
import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { ensureIsArray, usePrevious } from '@superset-ui/core';
import type { Metric } from '@superset-ui/core';
import { t } from '@apache-superset/core/translation';
import { isEqual } from 'lodash-es';
import ControlHeader from 'src/explore/components/ControlHeader';
import { Icons } from '@superset-ui/core/components/Icons';
import {
  AddIconButton,
  AddControlLabel,
  HeaderContainer,
  LabelsContainer,
} from 'src/explore/components/controls/OptionControls';
import type { Datasource } from 'src/explore/types';
import type { ISaveableDatasource } from 'src/SqlLab/components/SaveDatasetModal';
import MetricDefinitionValue from './MetricDefinitionValue';
import AdhocMetric, {
  AdhocMetricInput,
  dedupeAdhocMetricOptionName,
} from './AdhocMetric';
import AdhocMetricPopoverTrigger from './AdhocMetricPopoverTrigger';
import { savedMetricType } from './types';

type ColumnOption = { column_name: string; type: string };

/** An object carrying a non-empty `metric_name` (saved metric definition). */
export type SavedMetricObject = { metric_name: string };

/** A metric as held in control state: a saved metric name, a saved metric
 *  object, or an adhoc metric instance. */
export type MetricValue = string | SavedMetricObject | AdhocMetric;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isSavedMetricObject(
  value: unknown,
): value is SavedMetricObject {
  return (
    isRecord(value) &&
    typeof value.metric_name === 'string' &&
    value.metric_name !== ''
  );
}

export function isDictionaryForAdhocMetric(
  value: unknown,
): value is AdhocMetricInput {
  return (
    isRecord(value) &&
    !(value instanceof AdhocMetric) &&
    Boolean(value.expressionType)
  );
}

export function isMetricValue(value: unknown): value is MetricValue {
  return (
    typeof value === 'string' ||
    value instanceof AdhocMetric ||
    isSavedMetricObject(value)
  );
}

function getOptionName(value: unknown): string | undefined {
  return isRecord(value) && typeof value.optionName === 'string'
    ? value.optionName
    : undefined;
}

function getMetricColumn(value: unknown): unknown {
  return isRecord(value) ? value.column : undefined;
}

function getColumnName(column: unknown): string | undefined {
  return isRecord(column) && typeof column.column_name === 'string'
    ? column.column_name
    : undefined;
}

function getOptionsForSavedMetrics(
  savedMetrics: savedMetricType[] | undefined,
  currentMetricValues: unknown,
  currentMetric: MetricValue | null | undefined,
): savedMetricType[] {
  return (
    savedMetrics?.filter(savedMetric =>
      Array.isArray(currentMetricValues)
        ? !currentMetricValues.includes(savedMetric.metric_name) ||
          savedMetric.metric_name === currentMetric
        : savedMetric,
    ) ?? []
  );
}

// adhoc metrics are stored as dictionaries in URL params. We convert them back into the
// AdhocMetric class for typechecking, consistency and instance method access.
export function coerceAdhocMetrics(value: unknown): MetricValue[] {
  if (!value) {
    return [];
  }
  if (!Array.isArray(value)) {
    if (isDictionaryForAdhocMetric(value)) {
      return [new AdhocMetric(value)];
    }
    return isMetricValue(value) ? [value] : [];
  }
  // Metrics are identified by optionName when editing; regenerate any that
  // collide so each keeps a unique identity (see dedupeAdhocMetricOptionName).
  const seenOptionNames = new Set<string>();
  return value.reduce<MetricValue[]>((metrics, val: unknown) => {
    if (isDictionaryForAdhocMetric(val)) {
      metrics.push(
        dedupeAdhocMetricOptionName(new AdhocMetric(val), seenOptionNames),
      );
    } else if (isMetricValue(val)) {
      metrics.push(val);
    }
    return metrics;
  }, []);
}

const emptySavedMetric = { metric_name: '', expression: '' };

const getMetricsMatchingCurrentDataset = (
  value: unknown,
  columns: ColumnOption[] | undefined,
  savedMetrics: savedMetricType[] | undefined,
) =>
  ensureIsArray(value).filter((metric: unknown) => {
    if (typeof metric === 'string' || isSavedMetricObject(metric)) {
      const metricName =
        typeof metric === 'string' ? metric : metric.metric_name;
      return savedMetrics?.some(
        savedMetric => savedMetric.metric_name === metricName,
      );
    }
    const metricColumn = getMetricColumn(metric);
    const columnName = getColumnName(metricColumn);
    return columns?.some(
      column => !metricColumn || columnName === column.column_name,
    );
  });

export interface MetricsControlProps {
  name: string;
  onChange: (value: unknown) => void;
  multi?: boolean;
  value?: unknown;
  columns?: unknown[];
  savedMetrics?: savedMetricType[];
  datasource?: unknown;
  clearable?: boolean;
  isLoading?: boolean;
  [key: string]: unknown;
}

const MetricsControl = ({
  onChange = () => {},
  multi,
  value: propsValue,
  columns = [],
  savedMetrics = [],
  datasource,
  ...props
}: MetricsControlProps) => {
  const [value, setValue] = useState<MetricValue[]>(() =>
    coerceAdhocMetrics(propsValue),
  );
  const prevColumns = usePrevious(columns);
  const prevSavedMetrics = usePrevious(savedMetrics);

  // `columns` and `datasource` arrive untyped from the generic control props
  // and are forwarded to the option components as-is.
  const columnOptions = columns as ColumnOption[];
  const datasourceOption = datasource as Datasource & ISaveableDatasource;

  const handleChange = useCallback(
    (opts: unknown) => {
      // if clear out options
      if (opts === null) {
        onChange(null);
        return;
      }

      const transformedOpts = ensureIsArray(opts);
      const optionValues = transformedOpts
        .map((option: unknown) => {
          // pre-defined metric
          if (isSavedMetricObject(option)) {
            return option.metric_name;
          }
          return option;
        })
        .filter((option: unknown) => option);
      onChange(multi ? optionValues : optionValues[0]);
    },
    [multi, onChange],
  );

  const onNewMetric = useCallback(
    (newMetric: MetricValue) => {
      const newValue = [...value, newMetric];
      setValue(newValue);
      handleChange(newValue);
    },
    [handleChange, value],
  );

  const onMetricEdit = useCallback(
    (changedMetric: Metric | MetricValue, oldMetric: Metric | MetricValue) => {
      const oldMetricName = isSavedMetricObject(oldMetric)
        ? oldMetric.metric_name
        : undefined;
      const oldOptionName = getOptionName(oldMetric);
      const newValue = value.map(val => {
        const optionName = getOptionName(val);
        if (
          // compare saved metrics
          (val === oldMetricName ||
            // compare adhoc metrics
            optionName !== undefined) &&
          optionName === oldOptionName
        ) {
          return changedMetric;
        }
        return val;
      });
      setValue(newValue);
      handleChange(newValue);
    },
    [handleChange, value],
  );

  const onRemoveMetric = useCallback(
    (index: number) => {
      if (!Array.isArray(value)) {
        return;
      }
      const valuesCopy = [...value];
      valuesCopy.splice(index, 1);
      setValue(valuesCopy);
      handleChange(valuesCopy);
    },
    [handleChange, value],
  );

  const moveLabel = useCallback(
    (dragIndex: number, hoverIndex: number) => {
      const newValues = [...value];
      [newValues[hoverIndex], newValues[dragIndex]] = [
        newValues[dragIndex],
        newValues[hoverIndex],
      ];
      setValue(newValues);
    },
    [value],
  );

  const isAddNewMetricDisabled = useCallback(
    () => !multi && value.length > 0,
    [multi, value.length],
  );

  const savedMetricOptions = useMemo(
    () => getOptionsForSavedMetrics(savedMetrics, propsValue, null),
    [propsValue, savedMetrics],
  );

  const newAdhocMetric = useMemo(() => new AdhocMetric({}), [value]);
  const addNewMetricPopoverTrigger = useCallback(
    (trigger: React.ReactNode) => {
      if (isAddNewMetricDisabled()) {
        return trigger;
      }
      return (
        <AdhocMetricPopoverTrigger
          adhocMetric={newAdhocMetric}
          onMetricEdit={onNewMetric}
          columns={columnOptions}
          savedMetricsOptions={savedMetricOptions}
          savedMetric={emptySavedMetric}
          datasource={datasourceOption}
          isNew
        >
          {trigger}
        </AdhocMetricPopoverTrigger>
      );
    },
    [
      columnOptions,
      datasourceOption,
      isAddNewMetricDisabled,
      newAdhocMetric,
      onNewMetric,
      savedMetricOptions,
    ],
  );

  useEffect(() => {
    // Remove selected custom metrics that do not exist in the dataset anymore
    // Remove selected adhoc metrics that use columns which do not exist in the dataset anymore
    if (
      propsValue &&
      (!isEqual(prevColumns, columns) ||
        !isEqual(prevSavedMetrics, savedMetrics))
    ) {
      const matchingMetrics = getMetricsMatchingCurrentDataset(
        propsValue,
        columnOptions,
        savedMetrics,
      );
      if (!isEqual(matchingMetrics, propsValue)) {
        handleChange(matchingMetrics);
      }
    }
  }, [columns, handleChange, savedMetrics]);

  useEffect(() => {
    setValue(coerceAdhocMetrics(propsValue));
  }, [propsValue]);

  const onDropLabel = useCallback(
    () => handleChange(value),
    [handleChange, value],
  );

  const valueRenderer = useCallback(
    (option: MetricValue, index: number) => (
      <MetricDefinitionValue
        key={index}
        index={index}
        option={option}
        onMetricEdit={onMetricEdit}
        onRemoveMetric={onRemoveMetric}
        columns={columnOptions}
        datasource={datasourceOption}
        savedMetrics={savedMetrics}
        savedMetricsOptions={getOptionsForSavedMetrics(
          savedMetrics,
          value,
          value?.[index],
        )}
        onMoveLabel={moveLabel}
        onDropLabel={onDropLabel}
        multi={multi}
      />
    ),
    [
      columnOptions,
      datasourceOption,
      moveLabel,
      multi,
      onDropLabel,
      onMetricEdit,
      onRemoveMetric,
      savedMetrics,
      value,
    ],
  );

  return (
    <div className="metrics-select">
      <HeaderContainer>
        <ControlHeader {...props} />
        {addNewMetricPopoverTrigger(
          <AddIconButton
            disabled={isAddNewMetricDisabled()}
            data-test="add-metric-button"
          >
            <Icons.PlusOutlined iconSize="m" />
          </AddIconButton>,
        )}
      </HeaderContainer>
      <LabelsContainer>
        {value.length > 0
          ? value.map((value, index) => valueRenderer(value, index))
          : addNewMetricPopoverTrigger(
              <AddControlLabel>
                <Icons.PlusOutlined iconSize="m" />
                {t('Add metric')}
              </AddControlLabel>,
            )}
      </LabelsContainer>
    </div>
  );
};

// Was a PureComponent before the FC conversion; preserve shallow-equal skip.
export default memo(MetricsControl);
