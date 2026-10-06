# Spec Delta

## Purpose

Lets Jira Service Management administrators read and manage SLA metrics (start, pause and stop conditions; goals with JQL, target and calendar) and SLA calendars, with dry runs, plans and read-back.

## ADDED Requirements

### Requirement: Read SLA configuration
The system SHALL provide `jira_get_sla_configuration` (service desk or project key). It SHALL return each SLA metric with name, start, pause and stop conditions, and its goals in order (JQL, target duration, calendar). It SHALL also provide `jira_get_sla_conditions` to list the available start/pause/stop conditions and `jira_list_sla_calendars` to list calendars with time zone, working hours, holidays and the metrics that use them.

#### Scenario: Configuration of a service desk
- **WHEN** an administrator reads the SLA configuration of a service desk with two metrics
- **THEN** each metric is listed with its conditions and its goals in order

### Requirement: Create, change and delete SLA metrics
The system SHALL provide `jira_create_sla` ✎, `jira_update_sla` ✎ and `jira_delete_sla` ✎:
- `jira_create_sla` takes `name`, start/pause/stop conditions by name from the available conditions, and an ordered goal list of {JQL or "All remaining issues", target such as `4h` or `2d 4h`, calendar by name or id}.
- `jira_update_sla` takes a metric by id or exact name and any of those attributes.

Creating SHALL report already-satisfied when an SLA with that name exists with the same conditions and goals, and SHALL stop when it exists with different ones. The dry run SHALL show old and new conditions and goals. Changing conditions or goals SHALL carry a warning that JSM recalculates the SLA on existing requests. Deleting SHALL warn that the SLA values recorded on requests are lost. After a confirmed change the system SHALL read the metric back.

#### Scenario: Time to resolution with a 24×7 calendar
- **WHEN** an administrator creates SLA "Time to resolution" starting on "Issue created", stopping on "Resolution: Set", with goal `priority = Highest` → 4h on the 24×7 calendar and "All remaining issues" → 2d
- **THEN** after confirmation the metric exists with those conditions and goals in that order

#### Scenario: Unknown condition
- **WHEN** a condition name is not among the available conditions
- **THEN** the system rejects the request and lists the available conditions of that kind

#### Scenario: Recalculation warning
- **WHEN** an administrator changes a goal's target
- **THEN** the dry run warns that existing requests are recalculated

### Requirement: Manage SLA calendars
The system SHALL provide `jira_create_sla_calendar` ✎ (name, time zone, working hours per weekday or `24x7`, optional holidays), `jira_update_sla_calendar` ✎ and `jira_delete_sla_calendar` ✎. A calendar with the same name and settings SHALL be reported as already-satisfied. Deleting a calendar that goals use SHALL be refused, naming the metrics. Calendars SHALL be usable by name or id in goals.

#### Scenario: 24×7 calendar
- **WHEN** an administrator creates calendar "24×7 Europe/Moscow" with working hours `24x7`
- **THEN** after confirmation the calendar exists with all days and hours working in that time zone

#### Scenario: Calendar in use
- **WHEN** an administrator deletes a calendar used by a goal
- **THEN** the system refuses and names the metric and goal

### Requirement: Version gate
SLA and calendar writes SHALL be refused before any request on JSM versions other than the verified ones (11.3.x), naming the observed JSM version.

#### Scenario: Other JSM version
- **WHEN** JSM reports version 10.3.4 and an administrator creates an SLA
- **THEN** the system refuses with `Unsupported` and sends nothing
