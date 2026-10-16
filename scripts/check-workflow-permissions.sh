#!/usr/bin/env bash
# Only review-gate.yml may post commit statuses. Any workflow with
# `statuses: write` could post a passing review-gate status for its own pull
# request, so this fails on every other workflow that grants it, directly or
# through write-all, or that leaves its top-level permissions unset (the
# token then gets the repository default, which can include it).
#
# This is a text check, not a YAML parser, so it insists on the plain forms
# the workflows already use and fails on anything it cannot read for sure:
#   - `permissions:` is a block of `scope: level` lines, `{}` or `read-all`;
#   - a `statuses` key appears only as `statuses: read` or `none`;
#   - no `write-all`, and no double-quoted key with escapes in it.
# Comment lines are skipped, and so are the words inside a run step unless
# they are shaped like a key. It does not stop a step that posts a status
# with a token of its own; review of .github/ and the branch audit do.
#
# Usage: scripts/check-workflow-permissions.sh [ROOT]   (default: the repository)
set -euo pipefail

root="${1:-$(cd "$(dirname "$0")/.." && pwd -P)}"
if [ ! -d "$root/.github/workflows" ]; then
  echo "check-workflow-permissions: no workflows directory in $root" >&2
  exit 1
fi

perl - "$root" <<'PERL'
use strict;
use warnings;
use File::Find;

my $root = $ARGV[0];
my $exempt = ".github/workflows/review-gate.yml";
my @files;
find({ no_chdir => 1, wanted => sub {
  return if -d $_;
  push @files, $_ if /\.ya?ml\z/;
} }, "$root/.github/workflows");

my $fail = 0;
# Where a mapping key can start: the line (or a sequence item), inside a
# flow mapping, or after "? ". Optionally quoted.
my $key = qr/(?:^\s*(?:-\s+)?|[{,]\s*|\?\s*)["']?/;
sub bad { print STDERR "check-workflow-permissions: $_[0]\n"; $fail = 1; }

for my $file (sort @files) {
  (my $rel = $file) =~ s/^\Q$root\E\/+//;
  next if $rel eq $exempt;
  my $fh;
  unless (open($fh, "<", $file)) { bad("$rel: cannot read: $!"); next; }
  my ($top, $block) = (0, undef);
  while (my $line = <$fh>) {
    chomp $line;
    my $at = "$rel:$.";
    next if $line =~ /^\s*$/ || $line =~ /^\s*#/;
    my $indent = length(($line =~ /^(\s*)/)[0]);
    if (defined $block) {
      if ($indent > $block) {
        if ($line =~ /^\s*([a-z-]+):\s*(read|write|none)\s*(#.*)?$/) {
          bad("$at: grants statuses: write; only $exempt may") if $1 eq "statuses" && $2 eq "write";
        } else {
          bad("$at: write each permission as a plain `scope: level` line");
        }
        next;
      }
      undef $block;
    }
    if ($line =~ /"[^"]*\\[^"]*"\s*:/) {
      bad("$at: escaped key; spell keys out plainly");
    } elsif ($line =~ /${key}permissions["']?\s*:/i) {
      if ($line =~ /^(\s*)permissions:\s*(#.*)?$/) {
        $block = length $1;
        $top = 1 if $block == 0;
      } elsif ($line =~ /^(\s*)permissions:\s*(\{\}|read-all)\s*(#.*)?$/) {
        $top = 1 if length $1 == 0;
      } else {
        bad("$at: permissions must be a block of `scope: level` lines, {} or read-all");
      }
    } elsif ($line =~ /${key}statuses["']?\s*:/i) {
      bad("$at: statuses outside a plain permissions block") unless $line =~ /^\s*statuses:\s*(read|none)\s*(#.*)?$/;
    } elsif ($line =~ /write-all/i) {
      bad("$at: write-all grants statuses: write");
    }
  }
  close($fh) or bad("$rel: cannot read: $!");
  bad("$rel: no top-level permissions, so the token gets the repository default") unless $top;
}

if ($fail) { print STDERR "check-workflow-permissions: FAIL\n"; exit 1; }
printf "check-workflow-permissions: ok (%d workflows besides %s)\n", scalar(grep { (my $r = $_) =~ s/^\Q$root\E\/+//; $r ne $exempt } @files), $exempt;
PERL
