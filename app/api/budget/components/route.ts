import { NextResponse } from "next/server";
import {
  calculateBudgetComponents,
  type BudgetCalculationInput,
} from "@/lib/budget/calculate";

export const runtime = "nodejs";

function positiveInteger(value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function nonNegativeNumber(value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON request body." }, { status: 400 });
  }

  const days = positiveInteger(body.days);
  const people = positiveInteger(body.people);
  const budget = nonNegativeNumber(body.budget);
  const travelMethod = typeof body.travelMethod === "string" ? body.travelMethod.trim() : "";
  const localTravelMethod =
    typeof body.localTravelMethod === "string" ? body.localTravelMethod.trim() : "";
  const stayPreference =
    typeof body.stayPreference === "string" ? body.stayPreference.trim() : "";

  if (!days || !people || budget === null) {
    return NextResponse.json(
      { error: "days and people must be positive integers, and budget must be a non-negative number." },
      { status: 400 },
    );
  }

  if (!travelMethod || !localTravelMethod || !stayPreference) {
    return NextResponse.json(
      { error: "travelMethod, localTravelMethod, and stayPreference are required." },
      { status: 400 },
    );
  }

  const input: BudgetCalculationInput = {
    days,
    people,
    budget,
    travelMethod,
    localTravelMethod,
    stayPreference,
  };

  const components = calculateBudgetComponents(input);
  const subtotal = components
    .filter((item) => item.component !== "contingency")
    .reduce((sum, item) => sum + item.amount, 0);
  const total = subtotal + components.find((item) => item.component === "contingency")!.amount;

  return NextResponse.json({
    components,
    subtotal,
    total,
    budget,
    remaining: budget - total,
    currency: "INR",
    confidence: "fallback",
    source: "roveo",
  });
}
