# ZSkills

An open-source, self-hosted web app for visually exploring, reading, and learning
from Agent Skills.

Part of Z Studio.

## Direction

ZSkills helps people understand how Skills are written and organized, study
their instructions and supporting resources, and build their own expertise.

Run the service on a Mac or Linux machine and open its interface in a browser.
Each service instance reads Skills from folders on the machine where it runs,
including personal, project, and tool-managed locations.

A remote machine can run its own instance. Access that instance through an SSH
tunnel or an explicitly configured network endpoint. A service binds to loopback
by default; network access requires authentication and an appropriate protected
connection.

## Status

The project repository has been initialized. The product direction is a local web
service with a browser interface. Detailed features, interface design, framework,
packaging, and the open-source license will be discussed next. Application code
has not yet been added; the behavior above describes the intended design.

## Project documents

- [Product brief](docs/product-brief.md): confirmed decisions and open questions.
- [Contributor guidance](AGENTS.md): working conventions for this repository.
