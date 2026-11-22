use std::collections::HashMap;

// blunder odds vs 70%+ clock, move 24+, 4k-12k Lichess games per preset: (upper edge of clock share, factor)
const FACTORS_5_0: [(f64, f64); 5] = [(0.05, 2.87), (0.1, 2.25), (0.2, 2.27), (0.4, 1.83), (0.7, 1.51)];
const FACTORS_10_0: [(f64, f64); 5] = [(0.05, 1.90), (0.1, 1.67), (0.2, 1.29), (0.4, 1.39), (0.7, 1.35)];
const FACTORS_15_10: [(f64, f64); 5] = [(0.05, 1.32), (0.1, 1.30), (0.2, 1.19), (0.4, 1.05), (0.7, 1.04)];
pub const BLUNDER_LOSS: f64 = 0.30;
const COVERAGE: f64 = 0.95;
const MAX_CANDIDATES: usize = 8;
// the measurement only counted positions between 20% and 80% win chance
const BALANCED_CHANCES: f64 = 0.6;

pub struct Scored {
    pub uci: String,
    pub prob: f64,
    pub loss: f64,
}

pub fn clock_factor(share_left: f64, base_secs: f64) -> f64 {
    let table = if base_secs < 450.0 {
        &FACTORS_5_0
    } else if base_secs < 750.0 {
        &FACTORS_10_0
    } else {
        &FACTORS_15_10
    };
    table.iter().find(|(edge, _)| share_left < *edge).map_or(1.0, |(_, f)| *f)
}

pub fn is_balanced(best_chances: f64) -> bool {
    best_chances.abs() <= BALANCED_CHANCES
}

// Maia's likeliest moves until they cover most of the probability, always including the one it chose
pub fn candidate_moves(policy: &HashMap<String, f64>, chosen: &str) -> Vec<String> {
    let mut ranked: Vec<(&String, f64)> = policy.iter().filter(|(_, p)| **p > 0.0).map(|(m, p)| (m, *p)).collect();
    ranked.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(b.0)));
    let total: f64 = ranked.iter().map(|(_, p)| p).sum();
    let (mut out, mut covered) = (Vec::new(), 0.0);
    for (m, p) in ranked {
        if out.len() >= MAX_CANDIDATES || covered >= COVERAGE * total {
            break;
        }
        covered += p;
        out.push(m.clone());
    }
    if !out.iter().any(|m| m == chosen) {
        out.push(chosen.to_string());
    }
    out
}

// a blunder to play instead of `chosen`, drawn from Maia's own likely moves, or None to keep it
pub fn slip(chosen: &str, scored: &[Scored], factor: f64, u: [f64; 2]) -> Option<String> {
    if !(factor > 1.0) || !scored.iter().any(|s| s.uci == chosen && s.loss < BLUNDER_LOSS) {
        return None;
    }
    let blunders: Vec<&Scored> = scored.iter().filter(|s| s.loss >= BLUNDER_LOSS && s.prob > 0.0).collect();
    let mass: f64 = blunders.iter().map(|s| s.prob).sum();
    if u[0] >= ((factor - 1.0) * mass).min(1.0) {
        return None;
    }
    let mut pick = u[1] * mass;
    for s in &blunders {
        if pick < s.prob {
            return Some(s.uci.clone());
        }
        pick -= s.prob;
    }
    blunders.last().map(|s| s.uci.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(uci: &str, prob: f64, loss: f64) -> Scored {
        Scored { uci: uci.into(), prob, loss }
    }

    fn sample() -> Vec<Scored> {
        vec![s("e2e4", 0.6, 0.0), s("d2d4", 0.2, 0.02), s("h2h4", 0.1, 0.4), s("g2g4", 0.05, 0.6)]
    }

    #[test]
    fn full_clock_changes_nothing_and_pressure_raises_the_factor() {
        assert_eq!(clock_factor(1.0, 600.0), 1.0);
        assert_eq!(clock_factor(0.7, 600.0), 1.0);
        assert!(clock_factor(0.5, 600.0) > 1.0);
        assert!(clock_factor(0.02, 600.0) > clock_factor(0.5, 600.0));
        assert_eq!(clock_factor(f64::NAN, 600.0), 1.0);
        assert!(clock_factor(0.02, 300.0) > clock_factor(0.02, 900.0));
    }

    #[test]
    fn no_slip_without_pressure() {
        assert_eq!(slip("e2e4", &sample(), 1.0, [0.0, 0.0]), None);
    }

    #[test]
    fn slips_to_a_blunder_only_when_the_roll_allows() {
        // mass 0.15, factor 2 -> 15% chance
        assert!(slip("e2e4", &sample(), 2.0, [0.1, 0.0]).is_some());
        assert_eq!(slip("e2e4", &sample(), 2.0, [0.2, 0.0]), None);
    }

    #[test]
    fn the_blunder_is_one_of_the_candidates_weighted_by_probability() {
        assert_eq!(slip("e2e4", &sample(), 2.0, [0.0, 0.0]).as_deref(), Some("h2h4"));
        assert_eq!(slip("e2e4", &sample(), 2.0, [0.0, 0.5]).as_deref(), Some("h2h4"));
        assert_eq!(slip("e2e4", &sample(), 2.0, [0.0, 0.9]).as_deref(), Some("g2g4"));
        assert_eq!(slip("e2e4", &sample(), 2.0, [0.0, 0.9999]).as_deref(), Some("g2g4"));
    }

    #[test]
    fn keeps_a_move_that_is_already_a_blunder_and_positions_without_one() {
        assert_eq!(slip("h2h4", &sample(), 3.0, [0.0, 0.0]), None);
        let quiet = vec![s("e2e4", 0.7, 0.0), s("d2d4", 0.3, 0.05)];
        assert_eq!(slip("e2e4", &quiet, 3.0, [0.0, 0.0]), None);
        assert_eq!(slip("a2a3", &sample(), 3.0, [0.0, 0.0]), None);
    }

    #[test]
    fn the_chance_is_capped_at_certain() {
        let all = vec![s("e2e4", 0.1, 0.0), s("h2h4", 0.9, 0.5)];
        assert_eq!(slip("e2e4", &all, 5.0, [0.999, 0.0]).as_deref(), Some("h2h4"));
    }

    #[test]
    fn candidates_cover_the_likely_moves_and_the_chosen_one() {
        let policy: HashMap<String, f64> =
            [("e2e4", 0.6), ("d2d4", 0.3), ("c2c4", 0.06), ("h2h4", 0.03), ("a2a3", 0.01)].map(|(m, p)| (m.to_string(), p)).into();
        assert_eq!(candidate_moves(&policy, "e2e4"), ["e2e4", "d2d4", "c2c4"]);
        assert_eq!(candidate_moves(&policy, "a2a3").last().map(String::as_str), Some("a2a3"));
        let many: HashMap<String, f64> = (0..20).map(|i| (format!("m{i:02}"), 0.05)).collect();
        assert_eq!(candidate_moves(&many, "m00").len(), MAX_CANDIDATES);
    }

    #[test]
    fn decided_positions_are_left_alone() {
        assert!(is_balanced(0.3) && is_balanced(-0.6));
        assert!(!is_balanced(0.8) && !is_balanced(-0.9));
    }
}
