// API-1 section 10 (docs/api/contract.md): the telemetry catalog and field registry, and the counters of the 10.1
// families.
//
// The catalog is `data/api_telemetry.json`, a byte-identical copy of the Meeting Hub's `docs/api/telemetry.json`,
// embedded and parsed once. Parsing is strict (unknown keys, tags, classes, kinds, duplicate names, a counter that is
// not a monotonic sum all refuse it); a unit test parses the embedded copy, so a malformed catalog fails the build's
// tests, never a running process (which would then export nothing: the empty catalog refuses every record).
//
// Families (10.1): every family of the exposition with its Prometheus name, explicit OpenTelemetry name, type, unit,
// help words, labels (each tagged) and class. Records (10.4): every record type a destination may receive (each API
// audit action, each console audit action of the SIEM export, each structured log event, the API span) with its kind,
// class `as_is` and class once identities are pseudonymized or removed, where its severity comes from, and every
// allowed field (nested objects for nested paths) tagged `plain`, an identity tag or `free_text`.
//
// `transform_record` and `transform_labels` apply 10.4 and 11.4 for one destination, failing closed: a record type
// not in the registry, or above the destination's ceiling, is refused (11.5); a field outside the registry is dropped
// (an API audit entry with one is refused instead, since dropping it would break the chain's hashes); `free_text` is
// dropped with `message_redacted: true` unless identities are `as_is`; identity fields become pseudonyms exactly as
// `api_audit::pseudonym` makes them (a value already a pseudonym is kept), or are dropped.

use crate::api_audit::pseudonym;
use serde_json::{Map, Value};
use std::sync::LazyLock;

/// The embedded catalog (`docs/api/telemetry.json` of the Meeting Hub, copied byte for byte).
pub const SOURCE: &str = include_str!("../data/api_telemetry.json");
pub const VERSION: u64 = 1;
pub const TAGS: [&str; 7] = ["plain", "client", "principal", "device", "ip", "serial", "free_text"];
pub const CLASSES: [&str; 4] = ["public", "internal", "confidential", "cui"];
pub const KINDS: [&str; 4] = ["audit", "console_audit", "log", "span"];

/// A data class (6.4), ordered: a record is enqueued only at or below a destination's ceiling.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Ceiling {
    Public,
    Internal,
    Confidential,
    Cui,
}

impl Ceiling {
    pub fn of(s: &str) -> Option<Ceiling> {
        match s {
            "public" => Some(Ceiling::Public),
            "internal" => Some(Ceiling::Internal),
            "confidential" => Some(Ceiling::Confidential),
            "cui" => Some(Ceiling::Cui),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Ceiling::Public => "public",
            Ceiling::Internal => "internal",
            Ceiling::Confidential => "confidential",
            Ceiling::Cui => "cui",
        }
    }
}

/// A destination's `identities` (11.4).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Identities {
    AsIs,
    Pseudonymized,
    Removed,
}

impl Identities {
    pub fn of(s: &str) -> Option<Identities> {
        match s {
            "as_is" => Some(Identities::AsIs),
            "pseudonymized" => Some(Identities::Pseudonymized),
            "removed" => Some(Identities::Removed),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Identities::AsIs => "as_is",
            Identities::Pseudonymized => "pseudonymized",
            Identities::Removed => "removed",
        }
    }
}

/// A field or label tag (10.4).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Tag {
    Plain,
    Client,
    Principal,
    Device,
    Ip,
    Serial,
    FreeText,
}

impl Tag {
    pub fn of(s: &str) -> Option<Tag> {
        match s {
            "plain" => Some(Tag::Plain),
            "client" => Some(Tag::Client),
            "principal" => Some(Tag::Principal),
            "device" => Some(Tag::Device),
            "ip" => Some(Tag::Ip),
            "serial" => Some(Tag::Serial),
            "free_text" => Some(Tag::FreeText),
            _ => None,
        }
    }

    /// Pseudonymized or removed under 11.4.
    #[cfg(test)]
    pub fn identity(self) -> bool {
        !matches!(self, Tag::Plain | Tag::FreeText)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MetricKind {
    Gauge,
    Counter,
}

impl MetricKind {
    /// The Prometheus `# TYPE` word.
    pub fn prom_type(self) -> &'static str {
        match self {
            MetricKind::Gauge => "gauge",
            MetricKind::Counter => "counter",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LabelSpec {
    pub name: String,
    pub tag: Tag,
}

/// One metric family (10.1). A counter is an OpenTelemetry monotonic cumulative sum, a gauge a gauge.
#[derive(Clone, Debug)]
pub struct Family {
    pub prom: String,
    pub otel: String,
    pub kind: MetricKind,
    /// UCUM, as OpenTelemetry writes it (`s`, `By`, `%`, `d`, `min`, `1`, `{person}`).
    pub unit: String,
    pub help: String,
    pub labels: Vec<LabelSpec>,
    pub class: Ceiling,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecordKind {
    /// An API audit entry (9.2) of any representation.
    Audit,
    /// A console admin audit entry (the SIEM export's actions, `fleet_syslog::CEF_NAMES`).
    ConsoleAudit,
    /// A structured log line (`log.rs`: ts, level, cat, component, event, fields).
    Log,
    /// The attributes of an API span.
    Span,
}

impl RecordKind {
    fn of(s: &str) -> Option<RecordKind> {
        match s {
            "audit" => Some(RecordKind::Audit),
            "console_audit" => Some(RecordKind::ConsoleAudit),
            "log" => Some(RecordKind::Log),
            "span" => Some(RecordKind::Span),
            _ => None,
        }
    }
}

/// An allowed field: a tagged value, or an object whose own fields are listed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Field {
    Leaf(Tag),
    Object(Vec<(String, Field)>),
}

/// One record type of the registry (10.4).
#[derive(Clone, Debug)]
pub struct RecordType {
    pub name: String,
    pub kind: RecordKind,
    /// The class with identities `as_is`.
    pub class: Ceiling,
    /// The class with identities pseudonymized or removed (and free text dropped).
    pub class_transformed: Ceiling,
    /// The field whose value sets the severity (`result` or `level`); None for spans.
    pub severity_from: Option<String>,
    pub fields: Vec<(String, Field)>,
}

/// Why a record or series is not enqueued (11.5): `exports.refused` with reason `ceiling` or `identity`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refused {
    /// Above the destination's ceiling.
    Ceiling,
    /// Not in the registry (reason `identity`).
    Unknown,
}

impl Refused {
    /// The `reason` of `exports.refused` and `lucid_export_refused_total`.
    pub fn reason(self) -> &'static str {
        match self {
            Refused::Ceiling => "ceiling",
            Refused::Unknown => "identity",
        }
    }
}

pub struct Catalog {
    json: Value,
    families: Vec<Family>,
    records: Vec<RecordType>,
    /// Validated at load and read by the tests; the engine writes the same 10.2 names.
    #[cfg_attr(not(test), allow(dead_code))]
    resource_attributes: Vec<String>,
    /// (lowest CEF severity, highest, OpenTelemetry SeverityNumber).
    from_cef: Vec<(u8, u8, u8)>,
    outcomes: Vec<(String, u8)>,
    default_severity: u8,
}

/// The catalog, parsed once from the embedded copy; the empty catalog (every record refused) if it were malformed.
pub fn catalog() -> &'static Catalog {
    static CATALOG: LazyLock<Catalog> = LazyLock::new(|| parse(SOURCE).unwrap_or_else(|_| Catalog::empty()));
    &CATALOG
}

impl Catalog {
    fn empty() -> Catalog {
        Catalog { json: Value::Null, families: Vec::new(), records: Vec::new(), resource_attributes: Vec::new(), from_cef: Vec::new(), outcomes: Vec::new(), default_severity: 9 }
    }

    pub fn family(&self, prom: &str) -> Option<&Family> {
        self.families.iter().find(|f| f.prom == prom)
    }

    #[cfg(test)]
    pub fn families(&self) -> &[Family] {
        &self.families
    }

    /// The record type of a name; where a name is both an audit action and a log event, the audit action
    /// (`record_type_of` tells them apart by the record).
    pub fn record_type(&self, name: &str) -> Option<&RecordType> {
        let mut named = self.records.iter().filter(|r| r.name == name);
        let first = named.next()?;
        Some(if first.kind == RecordKind::Log { named.next().unwrap_or(first) } else { first })
    }

    /// The record type of `record` named `name`: a log line (a string `event`) is a log event of that name; an entry
    /// with a string `action` is an audit or console audit action of that name; anything else a span. The name the
    /// record carries must be `name`.
    pub fn record_type_of(&self, name: &str, record: &Value) -> Option<&RecordType> {
        let event = record.get("event").and_then(Value::as_str);
        let action = record.get("action").and_then(Value::as_str);
        let fits = |r: &&RecordType| match r.kind {
            RecordKind::Log => event == Some(name),
            RecordKind::Audit | RecordKind::ConsoleAudit => event.is_none() && action == Some(name),
            RecordKind::Span => event.is_none() && action.is_none(),
        };
        self.records.iter().filter(|r| r.name == name).find(fits)
    }

    #[cfg(test)]
    pub fn records(&self) -> &[RecordType] {
        &self.records
    }

    /// The 10.2 resource attribute names, in order (checked at load; the engine sets these names).
    #[cfg(test)]
    pub fn resource_attributes(&self) -> &[String] {
        &self.resource_attributes
    }

    /// The catalog as JSON (`GET I/v1/telemetry/catalog`).
    pub fn json(&self) -> &Value {
        &self.json
    }

    /// 10.3: the OpenTelemetry SeverityNumber of a record: its `result` (audit) or `level` (log) through
    /// `fleet_syslog::cef_severity`, then the catalog's CEF to SeverityNumber table; the default for spans, unknown
    /// records and records without the field.
    pub fn severity(&self, name: &str, record: &Value) -> u8 {
        let from = self.record_type_of(name, record).and_then(|r| r.severity_from.as_deref());
        let Some(outcome) = from.and_then(|f| record.get(f)).and_then(Value::as_str) else { return self.default_severity };
        if let Some((_, n)) = self.outcomes.iter().find(|(o, _)| o == outcome) {
            return *n;
        }
        let cef = crate::fleet_syslog::cef_severity(outcome);
        self.from_cef.iter().find(|(lo, hi, _)| (*lo..=*hi).contains(&cef)).map_or(self.default_severity, |(_, _, n)| *n)
    }
}

// ── strict parsing ─────────────────────────────────────────────────────────────────────────────────────────────

fn obj<'a>(v: &'a Value, what: &str) -> Result<&'a Map<String, Value>, String> {
    v.as_object().ok_or_else(|| format!("{what} is not an object"))
}

fn keys(m: &Map<String, Value>, required: &[&str], optional: &[&str], what: &str) -> Result<(), String> {
    if let Some(k) = m.keys().find(|k| !required.contains(&k.as_str()) && !optional.contains(&k.as_str())) {
        return Err(format!("{what}: unknown key {k}"));
    }
    match required.iter().find(|r| !m.contains_key(**r)) {
        Some(r) => Err(format!("{what}: {r} is missing")),
        None => Ok(()),
    }
}

fn text<'a>(m: &'a Map<String, Value>, k: &str, what: &str) -> Result<&'a str, String> {
    m.get(k).and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or_else(|| format!("{what}: {k} is not a non-empty string"))
}

fn flag(m: &Map<String, Value>, k: &str, what: &str) -> Result<bool, String> {
    m.get(k).and_then(Value::as_bool).ok_or_else(|| format!("{what}: {k} is not a boolean"))
}

fn class(m: &Map<String, Value>, k: &str, what: &str) -> Result<Ceiling, String> {
    Ceiling::of(text(m, k, what)?).ok_or_else(|| format!("{what}: {k} is not a class"))
}

fn words(v: Option<&Value>) -> Option<Vec<&str>> {
    v?.as_array()?.iter().map(Value::as_str).collect()
}

fn severity_number(v: Option<&Value>) -> Option<u8> {
    v?.as_u64().filter(|n| (1..=24).contains(n)).map(|n| n as u8)
}

fn no_dashes(s: &str) -> bool {
    !s.contains(['\u{2014}', '\u{2013}'])
}

fn prom_ok(s: &str) -> bool {
    s.starts_with("lucid_") && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_') && !s.ends_with('_')
}

fn otel_ok(s: &str) -> bool {
    s.starts_with("lucid.") && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.') && !s.ends_with('.') && !s.contains("..")
}

fn label_ok(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
}

fn record_name_ok(s: &str) -> bool {
    (1..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
}

fn field_name_ok(s: &str) -> bool {
    (1..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'.')
}

fn fields(v: &Value, what: &str) -> Result<Vec<(String, Field)>, String> {
    let m = obj(v, what)?;
    if m.is_empty() {
        return Err(format!("{what} lists no field"));
    }
    m.iter()
        .map(|(k, f)| {
            if !field_name_ok(k) {
                return Err(format!("{what}: {k} is not a field name"));
            }
            let field = match f {
                Value::String(t) => Field::Leaf(Tag::of(t).ok_or_else(|| format!("{what}.{k}: {t} is not a tag"))?),
                Value::Object(_) => Field::Object(fields(f, &format!("{what}.{k}"))?),
                _ => return Err(format!("{what}.{k} is neither a tag nor an object")),
            };
            Ok((k.clone(), field))
        })
        .collect()
}

fn family_of(v: &Value) -> Result<Family, String> {
    let m = obj(v, "a family")?;
    let prom = text(m, "prom", "a family")?;
    let what = format!("family {prom}");
    keys(m, &["prom", "otel", "type", "otel_type", "monotonic", "unit", "help", "labels", "class"], &[], &what)?;
    let otel = text(m, "otel", &what)?;
    if !prom_ok(prom) || !otel_ok(otel) {
        return Err(format!("{what}: a name is malformed"));
    }
    let kind = match text(m, "type", &what)? {
        "gauge" => MetricKind::Gauge,
        "counter" => MetricKind::Counter,
        t => return Err(format!("{what}: type {t}")),
    };
    let counter = kind == MetricKind::Counter;
    let sum = match text(m, "otel_type", &what)? {
        "sum" => true,
        "gauge" => false,
        t => return Err(format!("{what}: otel_type {t}")),
    };
    if sum != counter || flag(m, "monotonic", &what)? != counter {
        return Err(format!("{what}: a counter is a monotonic sum and a gauge a gauge"));
    }
    let help = text(m, "help", &what)?;
    if !no_dashes(help) {
        return Err(format!("{what}: help with a dash"));
    }
    let labels = obj(&m["labels"], &format!("{what} labels"))?
        .iter()
        .map(|(name, tag)| {
            let tag = tag.as_str().and_then(Tag::of).filter(|_| label_ok(name)).ok_or_else(|| format!("{what}: label {name}"))?;
            Ok(LabelSpec { name: name.clone(), tag })
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(Family { prom: prom.into(), otel: otel.into(), kind, unit: text(m, "unit", &what)?.into(), help: help.into(), labels, class: class(m, "class", &what)? })
}

fn record_of(v: &Value) -> Result<RecordType, String> {
    let m = obj(v, "a record")?;
    let name = text(m, "name", "a record")?;
    let what = format!("record {name}");
    keys(m, &["name", "kind", "class", "class_transformed", "fields"], &["severity_from"], &what)?;
    let kind = RecordKind::of(text(m, "kind", &what)?).ok_or_else(|| format!("{what}: kind"))?;
    if !record_name_ok(name) {
        return Err(format!("{what}: malformed name"));
    }
    let (class_as_is, class_transformed) = (class(m, "class", &what)?, class(m, "class_transformed", &what)?);
    if class_transformed > class_as_is {
        return Err(format!("{what}: transforming never raises the class"));
    }
    let severity_from = match (kind, m.get("severity_from")) {
        (RecordKind::Span, None) => None,
        (RecordKind::Log, Some(Value::String(s))) if s == "level" => Some(s.clone()),
        (RecordKind::Audit | RecordKind::ConsoleAudit, Some(Value::String(s))) if s == "result" => Some(s.clone()),
        _ => return Err(format!("{what}: severity_from")),
    };
    Ok(RecordType { name: name.into(), kind, class: class_as_is, class_transformed, severity_from, fields: fields(&m["fields"], &format!("{what} fields"))? })
}

/// The catalog from its JSON text, or why it is refused.
pub fn parse(text_in: &str) -> Result<Catalog, String> {
    let json: Value = serde_json::from_str(text_in).map_err(|e| format!("not JSON: {e}"))?;
    let m = obj(&json, "the catalog")?;
    keys(m, &["version", "contract", "tags", "classes", "kinds", "severity", "resource_attributes", "families", "records"], &[], "the catalog")?;
    if m["version"].as_u64() != Some(VERSION) {
        return Err("version is not 1".into());
    }
    text(m, "contract", "the catalog")?;
    if words(m.get("tags")).as_deref() != Some(&TAGS[..]) || words(m.get("classes")).as_deref() != Some(&CLASSES[..]) || words(m.get("kinds")).as_deref() != Some(&KINDS[..]) {
        return Err("tags, classes or kinds differ from this build's".into());
    }
    // severity: CEF 0 to 10 covered once, in order
    let s = obj(&m["severity"], "severity")?;
    keys(s, &["from_cef", "outcomes", "default"], &[], "severity")?;
    let mut from_cef = Vec::new();
    let mut next = 0u64;
    for r in s["from_cef"].as_array().ok_or("severity.from_cef is not a list")? {
        let r = obj(r, "a severity row")?;
        keys(r, &["cef", "otel"], &[], "a severity row")?;
        let range = r["cef"].as_array().filter(|a| a.len() == 2).and_then(|a| Some((a[0].as_u64()?, a[1].as_u64()?)));
        let (lo, hi) = range.filter(|(lo, hi)| *lo == next && hi >= lo && *hi <= 10).ok_or("severity rows must cover CEF 0 to 10 in order")?;
        let otel = severity_number(r.get("otel")).ok_or("a severity row's otel is not 1 to 24")?;
        from_cef.push((lo as u8, hi as u8, otel));
        next = hi + 1;
    }
    if next != 11 {
        return Err("severity rows must cover CEF 0 to 10".into());
    }
    let outcomes = obj(&s["outcomes"], "severity.outcomes")?
        .iter()
        .map(|(k, v)| severity_number(Some(v)).map(|n| (k.clone(), n)).ok_or_else(|| format!("severity outcome {k}")))
        .collect::<Result<Vec<_>, String>>()?;
    let default_severity = severity_number(s.get("default")).ok_or("severity.default is not 1 to 24")?;
    // resource attributes (10.2)
    let mut resource_attributes: Vec<String> = Vec::new();
    for a in m["resource_attributes"].as_array().ok_or("resource_attributes is not a list")? {
        let a = obj(a, "a resource attribute")?;
        keys(a, &["name", "required", "tag"], &["values", "meaning"], "a resource attribute")?;
        let name = text(a, "name", "a resource attribute")?;
        flag(a, "required", name)?;
        if text(a, "tag", name)? != "plain" || resource_attributes.iter().any(|n| n == name) {
            return Err(format!("resource attribute {name}"));
        }
        resource_attributes.push(name.into());
    }
    let families = m["families"].as_array().ok_or("families is not a list")?.iter().map(family_of).collect::<Result<Vec<_>, String>>()?;
    for (i, f) in families.iter().enumerate() {
        if families[..i].iter().any(|g| g.prom == f.prom || g.otel == f.otel) {
            return Err(format!("family {} is listed twice", f.prom));
        }
    }
    let records = m["records"].as_array().ok_or("records is not a list")?.iter().map(record_of).collect::<Result<Vec<_>, String>>()?;
    for (i, r) in records.iter().enumerate() {
        let audit = |k: RecordKind| matches!(k, RecordKind::Audit | RecordKind::ConsoleAudit);
        if records[..i].iter().any(|q| q.name == r.name && (q.kind == r.kind || (audit(q.kind) && audit(r.kind)))) {
            return Err(format!("record {} is listed twice", r.name));
        }
    }
    Ok(Catalog { json, families, records, resource_attributes, from_cef, outcomes, default_severity })
}

// ── transforms (10.4, 11.4, 11.5) ──────────────────────────────────────────────────────────────────────────────

/// `p_` and 16 lowercase hex.
fn is_pseudonym(s: &str) -> bool {
    s.len() == 18 && s.starts_with("p_") && s[2..].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// An identity value under `identities`: kept (`as_is`), a pseudonym (kept when it already is one), or None
/// (dropped: `removed`, or pseudonymized without a key).
fn identity_value(v: &Value, identities: Identities, key: Option<(u32, &[u8])>) -> Option<Value> {
    match (identities, key) {
        (Identities::AsIs, _) => Some(v.clone()),
        (Identities::Pseudonymized, Some((_, k))) => match v {
            Value::Null => Some(Value::Null),
            Value::String(s) if is_pseudonym(s) => Some(v.clone()),
            _ => Some(Value::from(pseudonym(k, &v.as_str().map_or_else(|| v.to_string(), str::to_owned)))),
        },
        _ => None,
    }
}

struct Walk {
    identities: Identities,
    /// An unlisted field refuses the record (API audit) instead of being dropped.
    strict: bool,
    redacted: bool,
    pseudonymized: bool,
}

impl Walk {
    fn object(&mut self, spec: &[(String, Field)], obj: &Map<String, Value>, key: Option<(u32, &[u8])>) -> Result<Map<String, Value>, Refused> {
        let mut out = Map::new();
        for (k, v) in obj {
            let Some((_, field)) = spec.iter().find(|(n, _)| n == k) else {
                if self.strict {
                    return Err(Refused::Unknown);
                }
                continue;
            };
            match (field, v) {
                (Field::Object(sub), Value::Object(inner)) => {
                    let inner = self.object(sub, inner, key)?;
                    out.insert(k.clone(), Value::Object(inner));
                }
                (Field::Leaf(tag), v) if !v.is_object() && !v.is_array() => match tag {
                    Tag::Plain => {
                        out.insert(k.clone(), v.clone());
                    }
                    Tag::FreeText if self.identities == Identities::AsIs => {
                        out.insert(k.clone(), v.clone());
                    }
                    Tag::FreeText => self.redacted = true,
                    _ => {
                        if let Some(x) = identity_value(v, self.identities, key) {
                            self.pseudonymized |= self.identities == Identities::Pseudonymized;
                            out.insert(k.clone(), x);
                        }
                    }
                },
                _ if self.strict => return Err(Refused::Unknown),
                _ => {}
            }
        }
        Ok(out)
    }
}

/// 10.4 and 11.5 for one destination: the record (`kind` its audit action, log event name or `api.span`) as the
/// destination may receive it, or why it is not enqueued. Audit classes follow 6.4 (`as_is` confidential, otherwise
/// internal), as every record type's `class` and `class_transformed`.
pub fn transform_record(kind: &str, record: &Value, identities: Identities, key: Option<(u32, &[u8])>, ceiling: Ceiling) -> Result<Value, Refused> {
    let cat = catalog();
    let rt = cat.record_type_of(kind, record).ok_or(Refused::Unknown)?;
    let class = if identities == Identities::AsIs { rt.class } else { rt.class_transformed };
    if class > ceiling {
        return Err(Refused::Ceiling);
    }
    let obj = record.as_object().ok_or(Refused::Unknown)?;
    let mut walk = Walk { identities, strict: rt.kind == RecordKind::Audit, redacted: false, pseudonymized: false };
    let mut out = walk.object(&rt.fields, obj, key)?;
    if walk.redacted {
        out.insert("message_redacted".into(), Value::Bool(true));
    }
    // a pseudonymized log line or console entry names its key version, as the audit chain's own entries do
    if let (true, Some((pkv, _)), RecordKind::Log | RecordKind::ConsoleAudit) = (walk.pseudonymized, key, rt.kind) {
        out.insert("pkv".into(), Value::from(pkv));
    }
    Ok(Value::Object(out))
}

/// 10.4 for one series of `family`: its labels in catalog order, identity labels as pseudonyms (pseudonymized with a
/// key) or removed (`removed`, or no key; the caller sums the series whose label sets become equal), labels the
/// family does not list dropped; `Ceiling` when the family's class is above the destination's.
pub fn transform_labels(family: &Family, labels: &[(String, String)], identities: Identities, key: Option<(u32, &[u8])>, ceiling: Ceiling) -> Result<Vec<(String, String)>, Refused> {
    if family.class > ceiling {
        return Err(Refused::Ceiling);
    }
    let mut out = Vec::with_capacity(family.labels.len());
    for spec in &family.labels {
        let Some((_, v)) = labels.iter().find(|(n, _)| *n == spec.name) else { continue };
        let kept = match spec.tag {
            Tag::Plain => Some(v.clone()),
            Tag::FreeText => (identities == Identities::AsIs).then(|| v.clone()),
            _ => identity_value(&Value::from(v.as_str()), identities, key).and_then(|x| x.as_str().map(str::to_owned)),
        };
        if let Some(x) = kept {
            out.push((spec.name.clone(), x));
        }
    }
    Ok(out)
}

// ── the 10.1 families' counters ─────────────────────────────────────────────────────────────────────────────────

/// The process's counters and gauges of the 10.1 families, per org (an org's `v1/metrics` and destinations see only
/// their own series; `rows(None)` is every org summed, the console's own `/metrics`). Label values are as decided
/// (`as_is`); destinations apply `transform_labels`.
pub mod counters {
    use parking_lot::Mutex;
    use std::collections::{BTreeMap, BTreeSet};
    use std::sync::LazyLock;

    /// The 10.1 families, in exposition order.
    pub const FAMILIES: [&str; 11] = [
        "lucid_api_requests_total",
        "lucid_api_refusals_total",
        "lucid_api_tokens_issued_total",
        "lucid_api_clients",
        "lucid_cert_grace_in_use",
        "lucid_export_backlog_bytes",
        "lucid_export_oldest_seconds",
        "lucid_export_failures_total",
        "lucid_export_refused_total",
        "lucid_export_last_success_seconds",
        "lucid_relay_mode",
    ];
    /// Series kept at most (a new series past it is not counted).
    pub const SERIES_MAX: usize = 10_000;
    /// `lucid_cert_grace_in_use`: a credential admitted inside a grace counts for an hour after its last use.
    pub const GRACE_WINDOW_S: i64 = 3600;

    /// One series of a 10.1 family.
    #[derive(Clone, Debug, PartialEq)]
    pub struct Row {
        pub prom: &'static str,
        pub labels: Vec<(String, String)>,
        pub value: f64,
    }

    type Key = (String, &'static str, Vec<(&'static str, String)>);

    #[derive(Default)]
    struct State {
        counts: BTreeMap<Key, u64>,
        gauges: BTreeMap<Key, f64>,
        /// (org, kind, serial) to the last grace use (s).
        grace: BTreeMap<(String, String, String), i64>,
        /// (org, destination) to the last successful delivery (s).
        success: BTreeMap<(String, String), i64>,
        mode: Option<String>,
    }

    static STATE: LazyLock<Mutex<State>> = LazyLock::new(Default::default);

    fn key(org: &str, prom: &'static str, labels: &[(&'static str, &str)]) -> Key {
        (org.to_owned(), prom, labels.iter().map(|(k, v)| (*k, (*v).to_owned())).collect())
    }

    fn add(org: &str, prom: &'static str, labels: &[(&'static str, &str)], n: u64) {
        if n == 0 {
            return;
        }
        let k = key(org, prom, labels);
        let s = &mut *STATE.lock();
        let full = s.counts.len() + s.gauges.len() >= SERIES_MAX;
        if let Some(c) = s.counts.get_mut(&k) {
            *c = c.saturating_add(n);
        } else if !full {
            s.counts.insert(k, n);
        }
    }

    fn set(org: &str, prom: &'static str, labels: &[(&'static str, &str)], v: f64) {
        let k = key(org, prom, labels);
        let s = &mut *STATE.lock();
        let full = s.counts.len() + s.gauges.len() >= SERIES_MAX;
        if let Some(g) = s.gauges.get_mut(&k) {
            *g = v;
        } else if !full {
            s.gauges.insert(k, v);
        }
    }

    /// An API decision on the token or resource pipeline (`result` `ok` or `refused`; `client` empty until the
    /// client is authenticated).
    pub fn api_request(org: &str, client: &str, result: &str) {
        add(org, "lucid_api_requests_total", &[("client", client), ("result", result)], 1);
    }

    /// A refusal by its check (6.2 code).
    pub fn api_refusal(org: &str, check: &str) {
        add(org, "lucid_api_refusals_total", &[("check", check)], 1);
    }

    /// A token released by `issuer` (`console` or `relay`).
    pub fn api_token_issued(org: &str, client: &str, issuer: &str) {
        add(org, "lucid_api_tokens_issued_total", &[("client", client), ("issuer", issuer)], 1);
    }

    /// The org's registered clients in `state`.
    pub fn set_api_clients(org: &str, state: &str, n: u64) {
        set(org, "lucid_api_clients", &[("state", state)], n as f64);
    }

    /// A credential (`serial`) of `kind` admitted inside its grace at `now_s`.
    pub fn grace_used(org: &str, kind: &str, serial: &str, now_s: i64) {
        let s = &mut *STATE.lock();
        s.grace.retain(|_, at| now_s - *at < GRACE_WINDOW_S);
        let k = (org.to_owned(), kind.to_owned(), serial.to_owned());
        if s.grace.len() < SERIES_MAX || s.grace.contains_key(&k) {
            s.grace.insert(k, now_s);
        }
    }

    /// `n` failed deliveries (or records dropped, reason `dropped`).
    pub fn export_failures(org: &str, destination: &str, reason: &str, n: u64) {
        add(org, "lucid_export_failures_total", &[("destination", destination), ("reason", reason)], n);
    }

    /// `n` records not enqueued (reason `ceiling` or `identity`).
    pub fn export_refused(org: &str, destination: &str, reason: &str, n: u64) {
        add(org, "lucid_export_refused_total", &[("destination", destination), ("reason", reason)], n);
    }

    pub fn set_export_backlog_bytes(org: &str, destination: &str, bytes: u64) {
        set(org, "lucid_export_backlog_bytes", &[("destination", destination)], bytes as f64);
    }

    pub fn set_export_oldest_seconds(org: &str, destination: &str, secs: u64) {
        set(org, "lucid_export_oldest_seconds", &[("destination", destination)], secs as f64);
    }

    /// A successful delivery at `at_s`.
    pub fn export_success(org: &str, destination: &str, at_s: i64) {
        let s = &mut *STATE.lock();
        let k = (org.to_owned(), destination.to_owned());
        if s.success.len() < SERIES_MAX || s.success.contains_key(&k) {
            s.success.insert(k, at_s);
        }
    }

    /// A deleted destination: its series go.
    pub fn remove_destination(org: &str, destination: &str) {
        let s = &mut *STATE.lock();
        let theirs = |(o, _, labels): &Key| o == org && labels.iter().any(|(k, v)| *k == "destination" && v == destination);
        s.counts.retain(|k, _| !theirs(k));
        s.gauges.retain(|k, _| !theirs(k));
        s.success.remove(&(org.to_owned(), destination.to_owned()));
    }

    /// This relay's mode (`normal` or `failover`), for every org. Set by the failover switch of slice 1a5; until then
    /// the exposition reports `normal`.
    #[allow(dead_code)]
    pub fn set_relay_mode(mode: &str) {
        STATE.lock().mode = Some(mode.to_owned());
    }

    /// Every series of `org` (None: every org, equal series summed) at `now_s`, in `FAMILIES` order, then by labels.
    pub fn rows(org: Option<&str>, now_s: i64) -> Vec<Row> {
        let mine = |o: &str| org.is_none_or(|x| x == o);
        let own = |labels: &[(&'static str, String)]| labels.iter().map(|(k, v)| ((*k).to_owned(), v.clone())).collect::<Vec<_>>();
        let mut merged: BTreeMap<(&'static str, Vec<(String, String)>), f64> = BTreeMap::new();
        {
            let s = STATE.lock();
            for ((o, prom, labels), n) in &s.counts {
                if mine(o.as_str()) {
                    *merged.entry((*prom, own(labels.as_slice()))).or_insert(0.0) += *n as f64;
                }
            }
            for ((o, prom, labels), v) in &s.gauges {
                if mine(o.as_str()) {
                    *merged.entry((*prom, own(labels.as_slice()))).or_insert(0.0) += *v;
                }
            }
            let mut grace: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
            for ((o, kind, serial), at) in &s.grace {
                if mine(o.as_str()) && now_s - *at < GRACE_WINDOW_S {
                    grace.entry(kind.as_str()).or_default().insert(serial.as_str());
                }
            }
            for (kind, serials) in grace {
                merged.insert(("lucid_cert_grace_in_use", vec![("kind".into(), kind.to_owned())]), serials.len() as f64);
            }
            let mut last: BTreeMap<&str, i64> = BTreeMap::new();
            for ((o, d), at) in &s.success {
                if mine(o.as_str()) {
                    let e = last.entry(d.as_str()).or_insert(*at);
                    *e = (*e).max(*at);
                }
            }
            for (d, at) in last {
                merged.insert(("lucid_export_last_success_seconds", vec![("destination".into(), d.to_owned())]), (now_s - at).max(0) as f64);
            }
            if let Some(m) = &s.mode {
                for mode in ["normal", "failover"] {
                    merged.insert(("lucid_relay_mode", vec![("mode".into(), mode.into())]), f64::from(u8::from(m == mode)));
                }
            }
        }
        let mut out: Vec<Row> = merged.into_iter().map(|((prom, labels), value)| Row { prom, labels, value }).collect();
        out.sort_by_key(|r| FAMILIES.iter().position(|f| *f == r.prom));
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fleet_export::HELP;
    use crate::fleet_metrics::{PromType, KEYS};
    use serde_json::json;

    /// RFC 4231 test case 2: HMAC-SHA-256("Jefe", "what do ya want for nothing?") = 5bdcc146bf60754e6a0424260895...
    const RFC4231_KEY: &[u8] = b"Jefe";
    const RFC4231_DATA: &str = "what do ya want for nothing?";
    const RFC4231_PSEUDONYM: &str = "p_5bdcc146bf60754e";
    const KEY: &[u8] = &[9; 32];

    fn cat() -> Catalog {
        parse(SOURCE).unwrap_or_else(|e| panic!("data/api_telemetry.json: {e}"))
    }

    #[test]
    fn the_embedded_catalog_parses_strictly() {
        let c = cat();
        assert_eq!(c.json()["version"], 1);
        assert_eq!(c.families().len(), 46);
        assert_eq!(catalog().families().len(), 46, "the process catalog is the embedded one");
        assert_eq!(c.resource_attributes(), ["service.name", "service.version", "service.instance.id", "lucid.org", "lucid.relay.id", "lucid.region", "deployment.environment"]);
        assert!(no_dashes(SOURCE));
        // each malformation refuses the whole catalog
        let base: Value = serde_json::from_str(SOURCE).unwrap();
        let broken = |f: &dyn Fn(&mut Value)| {
            let mut v = base.clone();
            f(&mut v);
            parse(&v.to_string()).is_err()
        };
        assert!(parse(&base.to_string()).is_ok());
        assert!(parse("{").is_err());
        assert!(broken(&|v| v["version"] = json!(2)));
        assert!(broken(&|v| v["extra"] = json!(1)));
        assert!(broken(&|v| v["families"][0]["extra"] = json!(1)));
        assert!(broken(&|v| v["families"][0]["labels"]["relay"] = json!("secret")));
        assert!(broken(&|v| v["families"][0]["class"] = json!("open")));
        assert!(broken(&|v| v["families"][8]["otel_type"] = json!("gauge")), "a counter that is not a sum");
        assert!(broken(&|v| v["families"][8]["monotonic"] = json!(false)));
        assert!(broken(&|v| v["families"][1]["prom"] = json!("lucid_console_info")), "a family listed twice");
        assert!(broken(&|v| v["families"][0]["help"] = json!("Version \u{2014} profile")));
        assert!(broken(&|v| {
            v["families"][0].as_object_mut().unwrap().remove("unit");
        }));
        assert!(broken(&|v| v["records"][0]["fields"]["client"] = json!("secret")));
        assert!(broken(&|v| v["records"][0]["fields"] = json!({})));
        assert!(broken(&|v| v["records"][0]["kind"] = json!("trace")));
        assert!(broken(&|v| v["records"][0]["class_transformed"] = json!("cui")), "transforming never raises the class");
        assert!(broken(&|v| v["records"][0]["severity_from"] = json!("level")));
        assert!(broken(&|v| v["records"][1]["name"] = json!("api.call")), "an audit action listed twice");
        assert!(broken(&|v| v["severity"]["from_cef"][1]["cef"] = json!([5, 6])), "a gap in the CEF table");
        assert!(broken(&|v| v["severity"]["default"] = json!(25)));
        assert!(broken(&|v| v["tags"] = json!(["plain"])));
        assert!(broken(&|v| v["resource_attributes"][0]["tag"] = json!("client")));
    }

    #[test]
    fn the_35_help_families_and_the_catalog_agree_word_for_word() {
        let c = cat();
        assert_eq!(HELP.len(), 35);
        for (i, (prom, words)) in HELP.iter().enumerate() {
            let f = &c.families()[i];
            assert_eq!((f.prom.as_str(), f.help.as_str()), (*prom, *words), "family {i} in HELP order");
            assert_eq!(f.class, Ceiling::Internal);
            let labels: Vec<&str> = f.labels.iter().map(|l| l.name.as_str()).collect();
            let want: &[&str] = match *prom {
                "lucid_console_info" => &["version", "profile", "fips"],
                "lucid_relay_health" | "lucid_relay_license_state" | "lucid_relay_license_service" => &["relay", "name", "site", "product", "state"],
                _ => &["relay", "name", "site", "product"],
            };
            assert_eq!(labels, want, "{prom}");
            assert!(f.labels.iter().all(|l| l.tag == Tag::Plain), "{prom}");
        }
        // the exposition's types: a 9.1 interval key is a counter, every other family a gauge
        for k in KEYS.iter() {
            let f = c.family(k.family).unwrap_or_else(|| panic!("{}", k.family));
            assert_eq!(f.kind == MetricKind::Counter, k.prom == PromType::Counter, "{}", k.family);
        }
        for prom in ["lucid_console_info", "lucid_relay_up", "lucid_relay_last_contact_seconds", "lucid_relay_health"] {
            assert_eq!(c.family(prom).unwrap().kind, MetricKind::Gauge);
        }
    }

    #[test]
    fn the_families_of_10_1_are_listed_with_their_types_and_labels() {
        let c = cat();
        let want: [(&str, MetricKind, &[(&str, Tag)]); 11] = [
            ("lucid_api_requests_total", MetricKind::Counter, &[("client", Tag::Client), ("result", Tag::Plain)]),
            ("lucid_api_refusals_total", MetricKind::Counter, &[("check", Tag::Plain)]),
            ("lucid_api_tokens_issued_total", MetricKind::Counter, &[("client", Tag::Client), ("issuer", Tag::Plain)]),
            ("lucid_api_clients", MetricKind::Gauge, &[("state", Tag::Plain)]),
            ("lucid_cert_grace_in_use", MetricKind::Gauge, &[("kind", Tag::Plain)]),
            ("lucid_export_backlog_bytes", MetricKind::Gauge, &[("destination", Tag::Plain)]),
            ("lucid_export_oldest_seconds", MetricKind::Gauge, &[("destination", Tag::Plain)]),
            ("lucid_export_failures_total", MetricKind::Counter, &[("destination", Tag::Plain), ("reason", Tag::Plain)]),
            ("lucid_export_refused_total", MetricKind::Counter, &[("destination", Tag::Plain), ("reason", Tag::Plain)]),
            ("lucid_export_last_success_seconds", MetricKind::Gauge, &[("destination", Tag::Plain)]),
            ("lucid_relay_mode", MetricKind::Gauge, &[("mode", Tag::Plain)]),
        ];
        assert_eq!(want.map(|w| w.0), counters::FAMILIES);
        for (i, (prom, kind, labels)) in want.iter().enumerate() {
            let f = &c.families()[35 + i];
            assert_eq!((f.prom.as_str(), f.kind, f.class), (*prom, *kind, Ceiling::Internal));
            let got: Vec<(&str, Tag)> = f.labels.iter().map(|l| (l.name.as_str(), l.tag)).collect();
            assert_eq!(got, *labels, "{prom}");
        }
    }

    /// 10.1: underscores to dots, `_total` off a counter, a unit suffix moved into `unit`.
    fn otel_rule(prom: &str, counter: bool) -> (String, Option<&'static str>) {
        let base = if counter { prom.strip_suffix("_total").unwrap_or(prom) } else { prom };
        for (suffix, unit) in [("_seconds", "s"), ("_bytes", "By"), ("_percent", "%"), ("_days", "d"), ("_minutes", "min")] {
            if let Some(stem) = base.strip_suffix(suffix) {
                return (stem.replace('_', "."), Some(unit));
            }
        }
        (base.replace('_', "."), None)
    }

    #[test]
    fn prometheus_to_opentelemetry_names_follow_rule_10_1() {
        let c = cat();
        for f in c.families() {
            let (otel, unit) = otel_rule(&f.prom, f.kind == MetricKind::Counter);
            assert_eq!(f.otel, otel, "{}", f.prom);
            match unit {
                Some(u) => assert_eq!(f.unit, u, "{}", f.prom),
                None => assert!(f.unit == "1" || (f.unit.starts_with('{') && f.unit.ends_with('}')), "{} unit {}", f.prom, f.unit),
            }
        }
        // the vectors (contract 18): the pairs a reader checks by hand
        for (prom, otel, unit, kind) in [
            ("lucid_relay_network_receive_bytes_total", "lucid.relay.network.receive", "By", MetricKind::Counter),
            ("lucid_relay_latency_console_seconds", "lucid.relay.latency.console", "s", MetricKind::Gauge),
            ("lucid_relay_cpu_host_percent", "lucid.relay.cpu.host", "%", MetricKind::Gauge),
            ("lucid_relay_cert_tls_days", "lucid.relay.cert.tls", "d", MetricKind::Gauge),
            ("lucid_relay_call_minutes_total", "lucid.relay.call", "min", MetricKind::Counter),
            ("lucid_relay_spokes_total", "lucid.relay.spokes.total", "{spoke}", MetricKind::Gauge),
            ("lucid_relay_messages_total", "lucid.relay.messages", "{message}", MetricKind::Counter),
            ("lucid_api_requests_total", "lucid.api.requests", "{request}", MetricKind::Counter),
            ("lucid_export_backlog_bytes", "lucid.export.backlog", "By", MetricKind::Gauge),
            ("lucid_export_last_success_seconds", "lucid.export.last.success", "s", MetricKind::Gauge),
            ("lucid_relay_mode", "lucid.relay.mode", "1", MetricKind::Gauge),
        ] {
            let f = c.family(prom).unwrap();
            assert_eq!((f.otel.as_str(), f.unit.as_str(), f.kind), (otel, unit, kind), "{prom}");
        }
    }

    /// Set `LUCID_MEETING_HUB_DIR` to the Meeting Hub checkout to compare; without it the core copy is canonical here.
    #[test]
    fn the_meeting_hub_copy_is_byte_identical() {
        let Ok(dir) = std::env::var("LUCID_MEETING_HUB_DIR") else {
            eprintln!("LUCID_MEETING_HUB_DIR unset: docs/api/telemetry.json not compared (the core copy is canonical in core tests)");
            return;
        };
        let path = std::path::Path::new(&dir).join("docs/api/telemetry.json");
        match std::fs::read(&path) {
            Ok(theirs) => assert!(theirs == SOURCE.as_bytes(), "{} differs from data/api_telemetry.json", path.display()),
            Err(e) => eprintln!("{}: {e}; not compared", path.display()),
        }
    }

    fn fields_of(rt: &RecordType) -> Vec<(&str, Tag)> {
        rt.fields
            .iter()
            .filter_map(|(k, f)| match f {
                Field::Leaf(t) => Some((k.as_str(), *t)),
                Field::Object(_) => None,
            })
            .collect()
    }

    fn sensitive(fields: &[(String, Field)]) -> bool {
        fields.iter().any(|(_, f)| match f {
            Field::Leaf(t) => *t != Tag::Plain,
            Field::Object(sub) => sensitive(sub),
        })
    }

    #[test]
    fn the_registry_lists_every_audit_action_field_and_security_line() {
        let c = cat();
        // 9.2 actions and the ones the writers add; every api_audit field, identity fields with their tags
        let actions = [
            "api.call", "api.token", "api.refusal", "api.refusal.summary", "cert.grace-used", "api.map.pinned", "api.map.conflict", "api.tighten", "api.journal.rebased",
            "exports.delivered", "exports.failed", "exports.refused", "relay.failover.on", "relay.failover.off", "checkpoint",
        ];
        let audit: Vec<&RecordType> = c.records().iter().filter(|r| r.kind == RecordKind::Audit).collect();
        assert_eq!(audit.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), actions);
        let mut allowed: Vec<&str> = crate::api_audit::PLAIN_FIELDS.to_vec();
        allowed.extend(crate::api_audit::IDENTITY_FIELDS);
        allowed.extend(["seq", "ts", "org", "prev", "hash", "bucket", "kid", "payload", "sig", "raw_seq", "pkv"]);
        allowed.sort_unstable();
        for r in &audit {
            let f = fields_of(r);
            let mut names: Vec<&str> = f.iter().map(|(k, _)| *k).collect();
            names.sort_unstable();
            assert_eq!(names, allowed, "{}", r.name);
            for (k, t) in &f {
                assert_eq!(t.identity(), crate::api_audit::IDENTITY_FIELDS.contains(k), "{}.{k}", r.name);
            }
            assert_eq!((r.class, r.class_transformed, r.severity_from.as_deref()), (Ceiling::Confidential, Ceiling::Internal, Some("result")), "6.4 for {}", r.name);
        }
        // the SIEM export's console actions
        for (action, _) in crate::fleet_syslog::CEF_NAMES {
            let r = c.records().iter().find(|r| r.name == action && r.kind == RecordKind::ConsoleAudit).unwrap_or_else(|| panic!("{action}"));
            assert!(r.fields.iter().any(|(k, f)| k == "detail" && *f == Field::Object(vec![("code".into(), Field::Leaf(Tag::Plain)), ("reason".into(), Field::Leaf(Tag::FreeText))])));
        }
        // the API's security lines
        for event in ["api.refusal", "cert.grace-used", "fleet.frame-refused", "api.audit-failed", "api.audit.failed", "api.audit.note", "api.map.conflict", "api.journal.conflict", "api.map.edition-refused"] {
            let r = c.records().iter().find(|r| r.name == event && r.kind == RecordKind::Log).unwrap_or_else(|| panic!("{event}"));
            for k in ["ts", "level", "cat", "component", "event"] {
                assert!(r.fields.iter().any(|(n, f)| n == k && *f == Field::Leaf(Tag::Plain)), "{event}.{k}");
            }
        }
        // a record with an identity or free text field is confidential as is, internal transformed; others internal
        for r in c.records() {
            let want = if sensitive(&r.fields) { Ceiling::Confidential } else { Ceiling::Internal };
            assert_eq!((r.class, r.class_transformed), (want, Ceiling::Internal), "{}", r.name);
        }
    }

    #[test]
    fn pseudonyms_are_api_audit_pseudonyms() {
        // the published HMAC-SHA-256 vector fixes the form
        assert_eq!(pseudonym(RFC4231_KEY, RFC4231_DATA), RFC4231_PSEUDONYM);
        let entry = json!({"action": "api.call", "client": RFC4231_DATA, "ip": "203.0.113.7", "result": "ok"});
        let out = transform_record("api.call", &entry, Identities::Pseudonymized, Some((3, RFC4231_KEY)), Ceiling::Internal).unwrap();
        assert_eq!(out["client"], RFC4231_PSEUDONYM);
        assert_eq!(out["ip"], json!(pseudonym(RFC4231_KEY, "203.0.113.7")));
        assert_eq!(out["result"], "ok");
        assert!(out.get("pkv").is_none(), "an audit entry carries its chain's own pkv");
        // an entry of the pseudonymized chain passes unchanged (no second HMAC), so its hash still verifies
        let chained = json!({"seq": 7, "ts": 1, "org": "acme", "action": "api.call", "client": RFC4231_PSEUDONYM, "result": "ok", "raw_seq": 7, "pkv": 3, "prev": "00", "hash": "11"});
        assert_eq!(transform_record("api.call", &chained, Identities::Pseudonymized, Some((3, RFC4231_KEY)), Ceiling::Internal).unwrap(), chained);
        // a number in an identity field is pseudonymized as its JSON text, as the chains do
        let log = json!({"ts": "t", "level": "warn", "cat": "security", "component": "relay", "event": "cert.grace-used", "serial": "01ab", "node": "n1", "hours_left": 3});
        let out = transform_record("cert.grace-used", &log, Identities::Pseudonymized, Some((2, KEY)), Ceiling::Internal).unwrap();
        assert_eq!((out["serial"].as_str(), out["node"].as_str()), (Some(pseudonym(KEY, "01ab").as_str()), Some(pseudonym(KEY, "n1").as_str())));
        assert_eq!((out["hours_left"].as_i64(), out["pkv"].as_u64()), (Some(3), Some(2)));
    }

    #[test]
    fn transform_record_fails_closed() {
        let call = json!({"action": "api.call", "client": "c_1", "ip": "198.51.100.1", "result": "ok"});
        // not in the registry: refused in every representation
        let unknown = json!({"action": "api.secret", "result": "ok"});
        for ids in [Identities::AsIs, Identities::Pseudonymized, Identities::Removed] {
            assert_eq!(transform_record("api.secret", &unknown, ids, Some((1, KEY)), Ceiling::Cui), Err(Refused::Unknown));
        }
        // the name the record carries must be the one asked for
        assert_eq!(transform_record("api.token", &call, Identities::AsIs, None, Ceiling::Cui), Err(Refused::Unknown));
        // an API audit entry with a field outside the registry is refused (dropping it would break the chain)
        let extra = json!({"action": "api.call", "result": "ok", "password": "x"});
        assert_eq!(transform_record("api.call", &extra, Identities::AsIs, None, Ceiling::Cui), Err(Refused::Unknown));
        // a log line's unlisted field is dropped
        let line = json!({"ts": "t", "level": "warn", "cat": "security", "component": "fleet", "event": "fleet.frame-refused", "relay": "r_1", "op": "hello", "token": "x"});
        let out = transform_record("fleet.frame-refused", &line, Identities::AsIs, None, Ceiling::Confidential).unwrap();
        assert!(out.get("token").is_none() && out["relay"] == "r_1");
        // 6.4 by representation: as_is is confidential, pseudonymized and removed internal; public gets nothing
        assert_eq!(transform_record("api.call", &call, Identities::AsIs, None, Ceiling::Internal), Err(Refused::Ceiling));
        assert!(transform_record("api.call", &call, Identities::AsIs, None, Ceiling::Confidential).is_ok());
        assert!(transform_record("api.call", &call, Identities::Pseudonymized, Some((1, KEY)), Ceiling::Internal).is_ok());
        assert!(transform_record("api.call", &call, Identities::Removed, None, Ceiling::Internal).is_ok());
        assert_eq!(transform_record("api.call", &call, Identities::Removed, None, Ceiling::Public), Err(Refused::Ceiling));
        assert_eq!(Refused::Unknown.reason(), "identity");
        assert_eq!(Refused::Ceiling.reason(), "ceiling");
        // not an object
        assert_eq!(transform_record("api.span", &json!("x"), Identities::AsIs, None, Ceiling::Cui), Err(Refused::Unknown));
    }

    #[test]
    fn removed_drops_identities_and_free_text_is_redacted_unless_as_is() {
        let line = json!({"ts": "t", "level": "warn", "cat": "security", "component": "api", "event": "api.refusal", "org": "acme", "code": "client", "source": "203.0.113.9", "client": "c_9", "why": "Ann's key ann@acme.example"});
        let as_is = transform_record("api.refusal", &line, Identities::AsIs, None, Ceiling::Confidential).unwrap();
        assert_eq!(as_is, line, "as is keeps everything listed");
        let removed = transform_record("api.refusal", &line, Identities::Removed, None, Ceiling::Internal).unwrap();
        assert_eq!(removed, json!({"ts": "t", "level": "warn", "cat": "security", "component": "api", "event": "api.refusal", "org": "acme", "code": "client", "message_redacted": true}));
        let pseudo = transform_record("api.refusal", &line, Identities::Pseudonymized, Some((4, KEY)), Ceiling::Internal).unwrap();
        assert_eq!(pseudo["source"], json!(pseudonym(KEY, "203.0.113.9")));
        assert_eq!((pseudo.get("why"), pseudo["message_redacted"].as_bool(), pseudo["pkv"].as_u64()), (None, Some(true), Some(4)));
        // pseudonymized without a key: the removed form (as the chains do with pkv 0)
        let keyless = transform_record("api.refusal", &line, Identities::Pseudonymized, None, Ceiling::Internal).unwrap();
        assert!(keyless.get("source").is_none() && keyless.get("client").is_none() && keyless.get("pkv").is_none());
        // the same name as an audit action takes the audit registry (no `why` there, no free text)
        let entry = json!({"action": "api.refusal", "ip": "203.0.113.9", "result": "refused", "check": "abuse", "count": 1});
        let out = transform_record("api.refusal", &entry, Identities::Removed, None, Ceiling::Internal).unwrap();
        assert_eq!(out, json!({"action": "api.refusal", "result": "refused", "check": "abuse", "count": 1}));
        // a console audit entry: detail.code kept, detail.reason redacted, the actor and target transformed
        let console = json!({"seq": 4, "ts": 5, "actor": "ann@acme.example", "role": "admin", "ip": null, "action": "people.remove", "target": "bob@acme.example", "result": "ok",
                             "approval": null, "stepup": true, "detail": {"code": "gone", "reason": "left the company", "extra": 1}, "prev": "00", "hash": "11"});
        let out = transform_record("people.remove", &console, Identities::Pseudonymized, Some((1, KEY)), Ceiling::Internal).unwrap();
        assert_eq!(out["actor"], json!(pseudonym(KEY, "ann@acme.example")));
        assert_eq!(out["target"], json!(pseudonym(KEY, "bob@acme.example")));
        assert_eq!(out["detail"], json!({"code": "gone"}));
        assert_eq!((out["ip"].clone(), out["message_redacted"].as_bool()), (Value::Null, Some(true)));
        assert!(out.get("role").is_none() && out.get("stepup").is_none() && out.get("prev").is_none(), "the SIEM allow-list only");
        // a span's client attribute
        let span = json!({"http.request.method": "GET", "http.route": "/api/orgs/{org}/v1/health", "http.response.status_code": 200, "lucid.client": "c_1", "lucid.org": "acme"});
        let out = transform_record("api.span", &span, Identities::Removed, None, Ceiling::Internal).unwrap();
        assert!(out.get("lucid.client").is_none() && out["http.response.status_code"] == 200);
        assert_eq!(transform_record("api.span", &span, Identities::AsIs, None, Ceiling::Internal), Err(Refused::Ceiling));
    }

    #[test]
    fn labels_are_transformed_like_fields() {
        let c = cat();
        let f = c.family("lucid_api_requests_total").unwrap();
        let labels = vec![("result".to_string(), "ok".to_string()), ("client".to_string(), RFC4231_DATA.to_string()), ("org".to_string(), "acme".to_string())];
        let as_is = transform_labels(f, &labels, Identities::AsIs, None, Ceiling::Internal).unwrap();
        assert_eq!(as_is, vec![("client".to_string(), RFC4231_DATA.to_string()), ("result".to_string(), "ok".to_string())], "catalog order; unlisted labels dropped");
        let pseudo = transform_labels(f, &labels, Identities::Pseudonymized, Some((1, RFC4231_KEY)), Ceiling::Internal).unwrap();
        assert_eq!(pseudo, vec![("client".to_string(), RFC4231_PSEUDONYM.to_string()), ("result".to_string(), "ok".to_string())]);
        let removed = transform_labels(f, &labels, Identities::Removed, Some((1, RFC4231_KEY)), Ceiling::Internal).unwrap();
        assert_eq!(removed, vec![("result".to_string(), "ok".to_string())], "the caller sums series that become equal");
        assert_eq!(transform_labels(f, &labels, Identities::AsIs, None, Ceiling::Public), Err(Refused::Ceiling));
        let plain = c.family("lucid_relay_up").unwrap();
        let row = vec![("relay".to_string(), "r_1".to_string()), ("name".to_string(), "Edge".to_string())];
        assert_eq!(transform_labels(plain, &row, Identities::Removed, None, Ceiling::Internal).unwrap(), row);
    }

    #[test]
    fn severity_follows_the_cef_mapping() {
        let c = cat();
        for (result, want) in [("ok", 9), ("waiting", 9), ("summary", 9), ("refused", 13), ("unknown", 13), ("failed", 17), ("error", 18), ("conflict", 9)] {
            assert_eq!(c.severity("api.call", &json!({"action": "api.call", "result": result})), want, "{result}");
        }
        for (level, want) in [("debug", 5), ("info", 9), ("warn", 13), ("error", 18)] {
            assert_eq!(c.severity("api.audit-failed", &json!({"event": "api.audit-failed", "level": level})), want, "{level}");
        }
        assert_eq!(c.severity("api.span", &json!({"lucid.org": "acme"})), 9);
        assert_eq!(c.severity("api.secret", &json!({"action": "api.secret", "result": "error"})), 9);
    }

    #[test]
    fn record_types_are_told_apart_by_the_record() {
        let c = cat();
        assert_eq!(c.record_type("api.refusal").map(|r| r.kind), Some(RecordKind::Audit));
        assert_eq!(c.record_type("fleet.frame-refused").map(|r| r.kind), Some(RecordKind::Log));
        assert_eq!(c.record_type_of("api.refusal", &json!({"event": "api.refusal", "level": "warn"})).map(|r| r.kind), Some(RecordKind::Log));
        assert_eq!(c.record_type_of("api.refusal", &json!({"action": "api.refusal"})).map(|r| r.kind), Some(RecordKind::Audit));
        assert_eq!(c.record_type_of("people.remove", &json!({"action": "people.remove"})).map(|r| r.kind), Some(RecordKind::ConsoleAudit));
        assert!(c.record_type_of("api.span", &json!({"action": "api.span"})).is_none());
        assert!(c.record_type_of("api.audit-failed", &json!({"action": "api.audit-failed"})).is_none(), "a log event is no audit action");
    }

    #[test]
    fn counters_are_kept_per_org_and_summed_for_the_console() {
        let (a, b) = ("cat-test-a", "cat-test-b");
        let now = 1_800_000_000;
        counters::api_request(a, "c_1", "ok");
        counters::api_request(a, "c_1", "ok");
        counters::api_request(b, "c_1", "ok");
        counters::api_refusal(a, "scope");
        counters::api_token_issued(a, "c_1", "console");
        counters::set_api_clients(a, "active", 3);
        counters::grace_used(a, "app", "01", now - 10);
        counters::grace_used(b, "app", "01", now - 10);
        counters::grace_used(b, "app", "02", now - GRACE_WINDOW_OLD);
        counters::export_failures(a, "d_1", "dropped", 5);
        counters::export_refused(a, "d_1", "ceiling", 0);
        counters::set_export_backlog_bytes(a, "d_1", 1024);
        counters::export_success(a, "d_1", now - 30);
        let find = |rows: &[counters::Row], prom: &str, labels: &[(&str, &str)]| {
            rows.iter().find(|r| r.prom == prom && r.labels.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect::<Vec<_>>() == labels).map(|r| r.value)
        };
        let ra = counters::rows(Some(a), now);
        assert_eq!(find(&ra, "lucid_api_requests_total", &[("client", "c_1"), ("result", "ok")]), Some(2.0));
        assert_eq!(find(&ra, "lucid_api_refusals_total", &[("check", "scope")]), Some(1.0));
        assert_eq!(find(&ra, "lucid_api_tokens_issued_total", &[("client", "c_1"), ("issuer", "console")]), Some(1.0));
        assert_eq!(find(&ra, "lucid_api_clients", &[("state", "active")]), Some(3.0));
        assert_eq!(find(&ra, "lucid_cert_grace_in_use", &[("kind", "app")]), Some(1.0));
        assert_eq!(find(&ra, "lucid_export_failures_total", &[("destination", "d_1"), ("reason", "dropped")]), Some(5.0));
        assert_eq!(find(&ra, "lucid_export_refused_total", &[("destination", "d_1"), ("reason", "ceiling")]), None, "zero adds no series");
        assert_eq!(find(&ra, "lucid_export_backlog_bytes", &[("destination", "d_1")]), Some(1024.0));
        assert_eq!(find(&ra, "lucid_export_last_success_seconds", &[("destination", "d_1")]), Some(30.0));
        let rb = counters::rows(Some(b), now);
        assert_eq!(find(&rb, "lucid_api_requests_total", &[("client", "c_1"), ("result", "ok")]), Some(1.0));
        assert_eq!(find(&rb, "lucid_cert_grace_in_use", &[("kind", "app")]), Some(1.0), "02 is past the hour");
        assert!(find(&rb, "lucid_export_backlog_bytes", &[("destination", "d_1")]).is_none(), "another org's destination");
        // every org: at least both orgs' series summed (other tests add their own)
        let all = counters::rows(None, now);
        assert!(find(&all, "lucid_api_requests_total", &[("client", "c_1"), ("result", "ok")]).is_some_and(|v| v >= 3.0));
        let order: Vec<usize> = all.iter().map(|r| counters::FAMILIES.iter().position(|f| *f == r.prom).unwrap()).collect();
        assert!(order.windows(2).all(|w| w[0] <= w[1]), "families in order");
        // a deleted destination's series go
        counters::remove_destination(a, "d_1");
        let ra = counters::rows(Some(a), now);
        assert!(ra.iter().all(|r| !r.labels.iter().any(|(k, v)| k == "destination" && v == "d_1")));
    }

    const GRACE_WINDOW_OLD: i64 = counters::GRACE_WINDOW_S + 1;
}
