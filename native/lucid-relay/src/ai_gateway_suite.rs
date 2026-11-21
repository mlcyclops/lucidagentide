// Contract AI-1 section 3.2 step 3: the quality suite `ai-ask-bench-v1`, shipped with the gateway. 200 synthetic
// questions over chats and meetings with known answers and the snippet that holds each answer.
//
// How the 200 are made (deterministic, so every gateway scores the same suite): TEMPLATES (10) times entity SETS
// (20). Item `n` uses template `n % 10` with set `n / 10`; its three snippets are the answer (at position `n % 3`)
// and two distractors written from the next two templates with sets 7 and 13 further on, which never hold the
// answer. To extend the suite, add a template (text, question, answer keywords, chat or meeting) to `TEMPLATES` or
// widen the entity lists, and raise SUITE_SIZE; a new version of the suite gets a new name (`ai-ask-bench-v2`) so
// scores of different suites are never compared.
//
// Scoring: an answer is right when it holds, for every keyword group, one of its alternatives (case-insensitive); a
// citation is valid when the answer cites the snippet that holds the answer and cites no id that was not sent.

use crate::ai_gateway_ask::filter_cites;

pub const SUITE: &str = "ai-ask-bench-v1";
pub const SUITE_SIZE: usize = 200;
pub const PASS_ANSWERS_PCT: u64 = 85;
pub const PASS_CITATIONS_PCT: u64 = 95;

const CITIES: [&str; 20] = ["Tampa", "Denver", "Austin", "Boise", "Raleigh", "Omaha", "Tucson", "Fresno", "Spokane", "Dayton", "Madison", "Reno", "Tulsa", "Albany", "Wichita", "Lansing", "Mobile", "Akron", "Eugene", "Provo"];
const LOTS: [&str; 20] = ["north", "south", "east", "west", "harbor", "river", "ridge", "valley", "lake", "park", "garden", "mill", "bridge", "orchard", "summit", "canyon", "meadow", "forest", "station", "airport"];
const FIRST: [&str; 20] = ["Ann", "Ben", "Cara", "Dev", "Elena", "Farid", "Grace", "Hiro", "Ines", "Jamal", "Kira", "Liam", "Mona", "Nils", "Omar", "Priya", "Quinn", "Rosa", "Sam", "Tara"];
const LAST: [&str; 20] = ["Lee", "Patel", "Kim", "Garcia", "Novak", "Okafor", "Silva", "Tanaka", "Rossi", "Moreau", "Haddad", "Berg", "Ivanova", "Chen", "Ortiz", "Walsh", "Dubois", "Sato", "Khan", "Larsen"];
const PROJECTS: [&str; 20] = ["Aurora", "Basalt", "Cobalt", "Delta", "Ember", "Falcon", "Granite", "Helix", "Iris", "Juniper", "Kestrel", "Lumen", "Mosaic", "Nimbus", "Onyx", "Prism", "Quartz", "Raven", "Sierra", "Tundra"];
const VENDORS: [&str; 20] = ["Acme Steel", "Bluefin Labs", "Crestline", "Dynamo Works", "Evergreen Supply", "Fieldstone", "Glacier Data", "Highpoint", "Ironclad", "Jetstream", "Keystone Parts", "Lakeshore", "Meridian", "Northwind", "Oakridge", "Pinnacle", "Quicksilver", "Redwood", "Stonebridge", "Trident"];
const PRODUCTS: [&str; 20] = ["badge readers", "laptops", "desk chairs", "routers", "projectors", "phones", "monitors", "printers", "door locks", "cameras", "headsets", "servers", "tablets", "scanners", "kiosks", "sensors", "displays", "docks", "keyboards", "whiteboards"];
const MONTHS: [&str; 12] = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const NUMBER_WORDS: [&str; 23] = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty", "twenty-one", "twenty-two"];

/// The facts of one entity set.
struct Set {
    city: &'static str,
    lot: &'static str,
    person: String,
    last: &'static str,
    project: &'static str,
    vendor: &'static str,
    vendor2: &'static str,
    product: &'static str,
    month: &'static str,
    day: u32,
    amount: u64,
    room: u32,
    count: usize,
}

fn set(s: usize) -> Set {
    Set {
        city: CITIES[s],
        lot: LOTS[(s * 7 + 3) % 20],
        person: format!("{} {}", FIRST[(s + 5) % 20], LAST[(s * 3 + 1) % 20]),
        last: LAST[(s * 3 + 1) % 20],
        project: PROJECTS[(s * 11 + 2) % 20],
        vendor: VENDORS[(s * 9 + 4) % 20],
        vendor2: VENDORS[(s * 9 + 14) % 20],
        product: PRODUCTS[(s * 13 + 6) % 20],
        month: MONTHS[(s * 5) % 12],
        day: (s as u32 * 3) % 27 + 2,
        amount: 10_000 + s as u64 * 2_500,
        room: 101 + s as u32 * 7,
        count: 3 + s,
    }
}

fn thousands(n: u64) -> String {
    let d = n.to_string();
    let mut out = String::new();
    for (i, c) in d.chars().enumerate() {
        if i > 0 && (d.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// (snippet text, question, keyword groups, meeting) of template `t` over set `x`.
fn template(t: usize, x: &Set) -> (String, String, Vec<Vec<String>>, bool) {
    let one = |s: &str| vec![vec![s.to_string()]];
    match t {
        0 => (format!("For the {} office we picked the {} lot.", x.city, x.lot), format!("Which lot did we pick for the {} office?", x.city), one(x.lot), false),
        1 => (
            format!("The {} budget is {} dollars for this year.", x.project, thousands(x.amount)),
            format!("What is the {} budget?", x.project),
            vec![vec![thousands(x.amount), x.amount.to_string()]],
            false,
        ),
        2 => (format!("We signed with {} for the new {}.", x.vendor, x.product), format!("Which vendor did we sign with for the new {}?", x.product), one(x.vendor), false),
        3 => (format!("{} owns the {} rollout from now on.", x.person, x.project), format!("Who owns the {} rollout?", x.project), one(x.last), false),
        4 => (format!("The {} design review moved to {} {}.", x.project, x.month, x.day), format!("When is the {} design review?", x.project), vec![vec![x.month.to_string()], vec![x.day.to_string()]], true),
        5 => (format!("The {} offsite will be in room {}.", x.city, x.room), format!("Which room is the {} offsite in?", x.city), one(x.room.to_string().as_str()), true),
        6 => (
            format!("We hired {} engineers for the {} team.", x.count, x.city),
            format!("How many engineers did we hire for the {} team?", x.city),
            vec![vec![x.count.to_string(), NUMBER_WORDS[x.count].to_string()]],
            false,
        ),
        7 => (
            format!("We will not use {} for {} because their price was too high.", x.vendor2, x.product),
            format!("Why are we not using {} for {}?", x.vendor2, x.product),
            vec![vec!["price".into(), "cost".into(), "expensive".into()]],
            false,
        ),
        8 => (format!("The {} contract must be signed by {} {}.", x.project, x.month, x.day), format!("By when must the {} contract be signed?", x.project), vec![vec![x.month.to_string()], vec![x.day.to_string()]], true),
        _ => (format!("The {} for {} ship from the {} warehouse.", x.product, x.project, x.city), format!("Which warehouse do the {} for {} ship from?", x.product, x.project), one(x.city), false),
    }
}

/// One snippet of an item.
#[derive(Clone, Debug)]
pub struct SuiteSnippet {
    pub id: String,
    pub from: String,
    pub meeting: bool,
    pub text: String,
}

/// One question with its known answer.
#[derive(Clone, Debug)]
pub struct Item {
    pub question: String,
    pub snippets: Vec<SuiteSnippet>,
    pub keywords: Vec<Vec<String>>,
    pub cite: String,
}

/// The 200 items, in order.
pub fn items() -> Vec<Item> {
    (0..SUITE_SIZE)
        .map(|n| {
            let (t, s) = (n % 10, n / 10);
            let x = set(s);
            let (text, question, keywords, meeting) = template(t, &x);
            let d1 = template((t + 1) % 10, &set((s + 7) % 20));
            let d2 = template((t + 2) % 10, &set((s + 13) % 20));
            let mut texts = vec![(d1.0, d1.3), (d2.0, d2.3)];
            let at = n % 3;
            texts.insert(at, (text, meeting));
            let snippets = texts
                .into_iter()
                .enumerate()
                .map(|(i, (text, meeting))| SuiteSnippet { id: format!("s{}", i + 1), from: format!("{} {}", FIRST[(n + i * 4) % 20], LAST[(n + i * 9 + 2) % 20]), meeting, text })
                .collect();
            Item { question, snippets, keywords, cite: format!("s{}", at + 1) }
        })
        .collect()
}

/// (the answer is right, the citations are valid) for one raw model answer.
pub fn score(item: &Item, raw: &str) -> (bool, bool) {
    let sent: Vec<String> = item.snippets.iter().map(|s| s.id.clone()).collect();
    let (clean, cites, foreign) = filter_cites(raw, &sent);
    let low = clean.to_lowercase();
    let right = item.keywords.iter().all(|group| group.iter().any(|k| low.contains(&k.to_lowercase())));
    (right, !foreign && cites.contains(&item.cite))
}

/// Whole percentages, rounded down.
pub fn pct(n: usize, of: usize) -> u64 {
    if of == 0 {
        0
    } else {
        (n * 100 / of) as u64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_suite_has_200_items_whose_answer_is_in_the_cited_snippet_only() {
        let all = items();
        assert_eq!(all.len(), SUITE_SIZE);
        for (n, it) in all.iter().enumerate() {
            assert_eq!(it.snippets.len(), 3);
            let holder = it.snippets.iter().find(|s| s.id == it.cite).unwrap();
            let has = |text: &str| it.keywords.iter().all(|g| g.iter().any(|k| text.to_lowercase().contains(&k.to_lowercase())));
            assert!(has(holder.text.as_str()), "item {n}: the cited snippet holds the answer");
            let question_words: Vec<&str> = it.question.split(|c: char| !c.is_alphanumeric()).filter(|w| w.len() > 3).collect();
            for other in it.snippets.iter().filter(|s| s.id != it.cite) {
                // a distractor never names the item's subject together with its answer
                let subject = question_words.iter().any(|w| other.text.contains(w) && w.chars().next().is_some_and(char::is_uppercase));
                assert!(!(subject && has(other.text.as_str())), "item {n}: a distractor also answers it");
            }
        }
        let distinct: std::collections::HashSet<&str> = all.iter().map(|i| i.question.as_str()).collect();
        assert_eq!(distinct.len(), SUITE_SIZE);
    }

    #[test]
    fn scoring_needs_the_keywords_and_the_right_citation() {
        let it = &items()[0];
        let lot = &it.keywords[0][0];
        let good = format!("We picked the {lot} lot [{}].", it.cite);
        assert_eq!(score(it, &good), (true, true));
        assert_eq!(score(it, &format!("We picked the {lot} lot.")), (true, false));
        assert_eq!(score(it, &format!("We picked the {lot} lot [{}][s9].", it.cite)), (true, false), "a cite of an id never sent");
        assert_eq!(score(it, &format!("No idea [{}].", it.cite)).0, false);
        assert_eq!((pct(170, 200), pct(189, 200), pct(1, 0)), (85, 94, 0));
    }
}
