# Formula Analysis for Goal Marker Position

## Understanding the Progress Circle

**What the circle represents:**
- Full circle (360°) = `caloriePool` calories eaten (where `caloriePool = TDEE + exercise`)
- When `caloriesEaten = caloriePool`, you're at 0 deficit
- Progress = `caloriesEaten / caloriePool`
- The circle fills clockwise from 12 o'clock as you eat more

## What the Goal Marker Should Represent

**Goal deficit of -750 means:**
- You want to eat `caloriePool - 750` calories to achieve a 750 calorie deficit
- Example: If `caloriePool = 2000`, goal calories = `2000 - 750 = 1250`
- Progress at goal = `1250 / 2000 = 0.625 = 62.5%`
- Angle on circle = `0.625 * 360° = 225°`

## User's Formula Analysis

**User's formula:**
```
degreesPerCalorie = 360 / caloriePool
totalDegrees = goal * degreesPerCalorie
```

**Example calculation:**
- `caloriePool = 2000`
- `goal = 750`
- `degreesPerCalorie = 360 / 2000 = 0.18°`
- `totalDegrees = 750 * 0.18 = 135°`

## The Problem

The user's formula calculates **135°**, but the dot should be at **225°** to match where the progress circle would be when you've eaten 1250 calories (to achieve the 750 deficit).

**The issue:** The formula uses the DEFICIT amount (750) directly, but the circle represents CALORIES EATEN. The dot should be at the position representing `caloriePool - goal` calories eaten, not `goal` calories.

## Correct Formula

To match the progress circle:
```
goalCalories = caloriePool - goal
progress = goalCalories / caloriePool
angle = progress * 360°
```

Or simplified:
```
angle = (caloriePool - goal) / caloriePool * 360°
angle = (1 - goal/caloriePool) * 360°
angle = 360° - (goal/caloriePool * 360°)
```

## Coordinate System

The SVG has `transform: rotate(-90deg)`, which means:
- 12 o'clock (top) in rotated view = 90° in standard SVG coords
- Counter-clockwise from top = increasing angle
- So: `finalAngle = 90° + calculatedAngle`

But wait - the progress circle uses `stroke-dashoffset` which starts at 12 o'clock and fills clockwise. So we need to match that behavior.
