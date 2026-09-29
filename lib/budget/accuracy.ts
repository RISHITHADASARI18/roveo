export type AccuracyLevel = "low" | "medium" | "high";

export type AccuracyRuleResult = {
  rule: string;
  passed: boolean;
  message: string;
};

export type BudgetAccuracyInput = {
  budget: number;
  total: number;
  components: {
    destinationTravel: number;
    accommodation: number;
    localTransport: number;
    food: number;
    activities: number;
    other: number;
    contingency: number;
  };
  currency: string;
  confidence: string;
  source: string;
};

export type BudgetAccuracyReport = {
  accurate: boolean;
  level: AccuracyLevel;
  verified: boolean;
  rules: AccuracyRuleResult[];
  warnings: string[];
};

function finiteNonNegative(value: number) {
  return Number.isFinite(value) && value >= 0;
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}

export function evaluateBudgetAccuracy(input: BudgetAccuracyInput): BudgetAccuracyReport {
  const componentValues = Object.values(input.components);
  const componentsValid = componentValues.every(finiteNonNegative);
  const calculatedTotal = round(
    input.components.destinationTravel +
      input.components.accommodation +
      input.components.localTransport +
      input.components.food +
      input.components.activities +
      input.components.other +
      input.components.contingency,
  );
  const arithmeticValid =
    componentsValid &&
    Number.isFinite(input.total) &&
    Math.abs(calculatedTotal - round(input.total)) < 0.01;
  const currencyValid = input.currency === "INR";
  const provenanceValid = Boolean(input.source?.trim());
  const fallbackMarkedCorrectly =
    input.source === "roveo" && input.confidence === "fallback";

  const rules: AccuracyRuleResult[] = [
    {
      rule: "non_negative_components",
      passed: componentsValid,
      message: componentsValid
        ? "All estimate components are finite and non-negative."
        : "One or more estimate components is invalid.",
    },
    {
      rule: "total_matches_components",
      passed: arithmeticValid,
      message: arithmeticValid
        ? "The stored total matches the sum of all stored components."
        : "The stored total does not match the component sum.",
    },
    {
      rule: "supported_currency",
      passed: currencyValid,
      message: currencyValid
        ? "The estimate uses the currently supported INR currency."
        : "The estimate uses an unsupported currency.",
    },
    {
      rule: "source_present",
      passed: provenanceValid,
      message: provenanceValid
        ? "The estimate identifies its calculation source."
        : "The estimate has no calculation source.",
    },
    {
      rule: "fallback_is_explicit",
      passed: fallbackMarkedCorrectly,
      message: fallbackMarkedCorrectly
        ? "Fallback estimates are explicitly marked as fallback."
        : "The estimate's confidence/source metadata does not correctly identify fallback data.",
    },
  ];

  const warnings: string[] = [];
  if (input.confidence === "fallback") {
    warnings.push(
      "This is a planning estimate, not a live price. Roveo should not present it as an exact current cost.",
    );
  }
  if (!arithmeticValid) {
    warnings.push("The estimate failed an arithmetic consistency check and should not be shown as verified.");
  }
  if (!currencyValid) {
    warnings.push("Currency validation failed.");
  }
  if (!provenanceValid) {
    warnings.push("Source provenance is missing.");
  }

  const allRulesPass = rules.every((rule) => rule.passed);
  const verified = allRulesPass && input.confidence !== "fallback";

  return {
    accurate: allRulesPass,
    level: verified ? "high" : allRulesPass ? "low" : "low",
    verified,
    rules,
    warnings,
  };
}
