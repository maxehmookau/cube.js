import { BaseQuery } from './BaseQuery';
import { BaseFilter } from './BaseFilter';

const GRANULARITY_TO_INTERVAL = {
  day: 'DAY',
  week: 'WEEK(MONDAY)',
  hour: 'HOUR',
  minute: 'MINUTE',
  second: 'SECOND',
  month: 'MONTH',
  quarter: 'QUARTER',
  year: 'YEAR'
};

class BigqueryFilter extends BaseFilter {
  likeIgnoreCase(column, not, param, type) {
    const p = (!type || type === 'contains' || type === 'ends') ? '%' : '';
    const s = (!type || type === 'contains' || type === 'starts') ? '%' : '';
    return `LOWER(${column})${not ? ' NOT' : ''} LIKE CONCAT('${p}', LOWER(${this.allocateParam(param)}) , '${s}')`;
  }

  castParameter() {
    if (this.definition().type === 'boolean') {
      return 'CAST(? AS BOOL)';
    } else if (this.measure || this.definition().type === 'number') {
      // TODO here can be measure type of string actually
      return 'CAST(? AS FLOAT64)';
    }
    return '?';
  }

  castToString(sql) {
    return `CAST(${sql} as STRING)`;
  }
}

export class BigqueryQuery extends BaseQuery {
  convertTz(field) {
    return `DATETIME(${field}, '${this.timezone}')`;
  }

  timeStampCast(value) {
    return `TIMESTAMP(${value})`;
  }

  dateTimeCast(value) {
    return `DATETIME(TIMESTAMP(${value}))`;
  }

  escapeColumnName(name) {
    return `\`${name}\``;
  }

  timeGroupedColumn(granularity, dimension) {
    return `DATETIME_TRUNC(${dimension}, ${GRANULARITY_TO_INTERVAL[granularity]})`;
  }

  newFilter(filter) {
    return new BigqueryFilter(this, filter);
  }

  dateSeriesSql(timeDimension) {
    return `${timeDimension.dateSeriesAliasName()} AS (${this.seriesSql(timeDimension)})`;
  }

  seriesSql(timeDimension) {
    const values = timeDimension.timeSeries().map(
      ([from, to]) => `select '${from}' f, '${to}' t`
    ).join(' UNION ALL ');
    return `SELECT ${this.dateTimeCast('dates.f')} date_from, ${this.dateTimeCast('dates.t')} date_to FROM (${values}) AS dates`;
  }

  overTimeSeriesSelect(cumulativeMeasures, dateSeriesSql, baseQuery, dateJoinConditionSql, baseQueryAlias) {
    const forSelect = this.overTimeSeriesForSelect(cumulativeMeasures);
    const outerSeriesAlias = this.cubeAlias('outer_series');
    const outerBase = this.cubeAlias('outer_base');
    const timeDimensionAlias = this.timeDimensions.map(d => d.aliasName()).filter(d => !!d)[0];
    const aliasesForSelect = this.timeDimensions.map(d => d.dateSeriesSelectColumn(outerSeriesAlias)).concat(
      this.dimensions.concat(cumulativeMeasures).map(s => s.aliasName())
    ).filter(c => !!c).join(', ');
    const dateSeriesAlias = this.timeDimensions.map(d => `${d.dateSeriesAliasName()}`).filter(c => !!c)[0];
    return `
    WITH ${dateSeriesSql} SELECT ${aliasesForSelect} FROM
    ${dateSeriesAlias} ${outerSeriesAlias}
    LEFT JOIN (
      SELECT ${forSelect} FROM ${dateSeriesAlias}
      INNER JOIN (${baseQuery}) AS ${baseQueryAlias} ON ${dateJoinConditionSql}
      ${this.groupByClause()}
    ) AS ${outerBase} ON ${outerSeriesAlias}.${this.escapeColumnName('date_from')} = ${outerBase}.${timeDimensionAlias}
    `;
  }

  subtractInterval(date, interval) {
    return `DATETIME_SUB(${date}, INTERVAL ${interval})`;
  }

  addInterval(date, interval) {
    return `DATETIME_ADD(${date}, INTERVAL ${interval})`;
  }

  subtractTimestampInterval(date, interval) {
    return `TIMESTAMP_SUB(${date}, INTERVAL ${interval})`;
  }

  addTimestampInterval(date, interval) {
    return `TIMESTAMP_ADD(${date}, INTERVAL ${interval})`;
  }

  nowTimestampSql() {
    return 'CURRENT_TIMESTAMP()';
  }

  unixTimestampSql() {
    return `UNIX_SECONDS(${this.nowTimestampSql()})`;
  }

  // eslint-disable-next-line no-unused-vars
  preAggregationLoadSql(cube, preAggregation, tableName) {
    return this.preAggregationSql(cube, preAggregation);
  }

  hllInit(sql) {
    return `HLL_COUNT.INIT(${sql})`;
  }

  hllMerge(sql) {
    return `HLL_COUNT.MERGE(${sql})`;
  }

  countDistinctApprox(sql) {
    return `APPROX_COUNT_DISTINCT(${sql})`;
  }

  concatStringsSql(strings) {
    return `CONCAT(${strings.join(', ')})`;
  }

  defaultRefreshKeyRenewalThreshold() {
    return 120;
  }

  defaultEveryRefreshKey() {
    return {
      every: '2 minutes'
    };
  }

  sqlTemplates() {
    const templates = super.sqlTemplates();
    templates.quotes.identifiers = '`';
    templates.quotes.escape = '\\`';
    templates.functions.DATETRUNC = 'DATETIME_TRUNC(CAST({{ args[1] }} AS DATETIME), {{ date_part }})';
    templates.functions.LOG = 'LOG({{ args_concat }}{% if args[1] is undefined %}, 10{% endif %})';
    templates.expressions.binary = '{% if op == \'%\' %}MOD({{ left }}, {{ right }}){% else %}({{ left }} {{ op }} {{ right }}){% endif %}';
    templates.expressions.interval = 'INTERVAL {{ interval }}';
    templates.expressions.extract = 'EXTRACT({% if date_part == \'DOW\' %}DAYOFWEEK{% elif date_part == \'DOY\' %}DAYOFYEAR{% else %}{{ date_part }}{% endif %} FROM {{ expr }})';
    return templates;
  }
}
